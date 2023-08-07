const TelegramBot = require('node-telegram-bot-api');
const functions = require('./functions'); //Импорт функций из файла
const token = '5938528546:AAEvGKSYW0rkp42x4B8zwJIp-vgoXHpLLLc'; //API-токен бота
const bot = new TelegramBot(token, {polling: true}); //Создание бота
const sqlite3 = require('sqlite3').verbose(); //Зависимость с БД
const {google} = require('googleapis'); //Зависимость с API Google Cloud
const fs = require('fs'); //Модуль файловой системы
const moment = require('moment-timezone'); //Модуль таймзоны
const schedule = require('node-schedule'); //Модуль расписания
let tempMsgEditRes = {}; //Временный массив для идентификаторов сообщения
let tempMsgEditResid = {}; //Временный массив для идентификаторов заявок
let adminanswer = {}; //Временный массив для сообщения администратора
let adminanswerid = {}; //Временный массив для идентификатора заявок
let sentMessages = {}; //Временный массив для сохранения идентификаторов сообщения по заявкам
let eventsid = {}; //Временный массив для хранения идентификаторов событий
const scheduledNotifications = {}; //Объект для хранения задач оповещения
const userStatuses = {}; //Глобальный объект для хранения статуса пользователей
const userState = {}; //Массив состояний
const reservationsData = {};//Массив хранения заявок
let currentBookingId; //Временная переменная заявки

const CALENDAR_ID = '9b4168e6710547f5f99cc0b1ca9d468fcdee49436b0fff4a160e78de1b2a42f0@group.calendar.google.com'; //Идентификатор календаря
const KEYFILE = 'reserv-calendar-bot-d9f4206b556b.json'; //Путь к JSON файлу
const SCOPE_CALENDAR = 'https://www.googleapis.com/auth/calendar'; //Интеграция модуля календаря
const SCOPE_EVENTS = 'https://www.googleapis.com/auth/calendar.events'; //Интеграция модуля событий 
const SCOPE_READONLY = 'https://www.googleapis.com/auth/calendar.readonly'; //Интеграция модуля чтения
const db = new sqlite3.Database('reservbase.db'); //Подключение к локальной БД
const filepath = 'reservbase.db'; //Файл БД
const AdminchatId = -1001872513549; //ID Администратора (админ-чата)
setInterval(checkNewreserv, 10000); //Интервал проверки таблицы на новые заявки
setInterval(scheduleNotifications, 30000); //Интервал проверки таблицы на оповещения


//Кнопка меню
const menubutton = {
  reply_markup: {
    inline_keyboard: [[
      {
        text: 'Меню',
        callback_data: 'mainmenu' 
      }
    ]]
  },
  parse_mode: 'HTML'
};

const menubuttonadmcom = {
    reply_markup: {
    inline_keyboard: [[
      { text: 'Меню', callback_data: 'mainmenu' },
      { text: 'Ответить', callback_data: 'answerusertoadmin' }
    ]]
  },
  parse_mode: 'HTML'
};

//Авторизация и создание клиента для работы с API
async function getAuthorizedClient() {
  const credentials = JSON.parse(fs.readFileSync(KEYFILE));
  const { client_email, private_key } = credentials;

  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email,
      private_key,
    },
    scopes: [SCOPE_CALENDAR, SCOPE_EVENTS],
  });

  return auth.getClient();
}

//Функция для формирования матрицы времени
function chunkArray(array, size) {
  return Array.from({ length: Math.ceil(array.length / size) }, (_, index) =>
    array.slice(index * size, index * size + size)
  );
}

//Функция для получения свободных часов для бронирования
async function getAvailableTimeSlots(selectedDate) {
  const auth = new google.auth.GoogleAuth({
    keyFile: KEYFILE,
    scopes: SCOPE_EVENTS,
  });

  const calendarId = CALENDAR_ID
  const eventDate = moment(selectedDate, 'DD:MM').format('YYYY-MM-DD');
  const date = eventDate

  try {
    const client = await getAuthorizedClient();
    const calendar = google.calendar({ version: 'v3', auth: client });
    const response = await calendar.events.list({
      auth,
      calendarId,
      timeMin: `${date}T00:00:00Z`,
      timeMax: `${date}T23:00:00Z`,
      singleEvents: true,
    });

    moment.tz.setDefault('Europe/Moscow');

    const busySlots = response.data.items.map((event) => {
      const start = moment(event.start.date || event.start.dateTime).subtract(4, 'Europe/Moscow');
      const end = moment(event.end.date || event.end.dateTime).subtract(4, 'Europe/Moscow');
      return {
        start: start.hour(),
        end: end.hour(),
      };
    });

    const availableSlots = [];
    for (let i = 9; i <= 19; i++) {
      if (!busySlots.some((busySlot) => i >= busySlot.start && i < busySlot.end)) {
        availableSlots.push(`${String(i).padStart(2, '0')}:00`);
      }
    }

    availableSlots.sort();
    const keyboardMatrix = chunkArray(availableSlots, 3);
    return keyboardMatrix;
  } catch (error) {
    console.error('Ошибка при получении событий календаря:', error);
    return [];
  }
}

//Функция удаления события из календаря
async function deleteEvent(eventId) {
  try {
    const client = await getAuthorizedClient();
    const calendar = google.calendar({ version: 'v3', auth: client });

    await calendar.events.delete({
      calendarId: CALENDAR_ID,
      eventId: eventId,
    });

    return true;
  } catch (error) {
    console.error('Ошибка удаления события:', error);
    return false;
  }
}

//Функция оповещения за 2 часа до события
function scheduleNotifications() {
  for (const eventId in scheduledNotifications) {
    delete scheduledNotifications[eventId];
  }

  db.all('SELECT * FROM reservations WHERE Статус = ?', ['Одобрено'], (err, rows) => {
    if (err) {
      console.error('Ошибка при выполнении запроса!');
      return;
    }

    const currentTime = new Date();

    // Проход по каждому событию и расчет времени оповещения
    rows.forEach((event) => {
      const eventDate = event.Дата;
      const eventTime = event.Время;
      const chatId = event.chatId;
      const eventId = event.id;

      // Разбиваем строку даты и времени на отдельные компоненты
      const [day, month] = eventDate.split('.');
      const [hours, minutes] = eventTime.split(':');

      // Получаем объект Date с заданной датой и временем
      const notificationTime = new Date();
      notificationTime.setFullYear(new Date().getFullYear()); // Устанавливаем текущий год, чтобы сохранить правильные даты
      notificationTime.setMonth(parseInt(month) - 1); // Месяцы в объекте Date начинаются с 0, поэтому вычитаем 1
      notificationTime.setDate(parseInt(day));
      notificationTime.setHours(parseInt(hours));
      notificationTime.setMinutes(parseInt(minutes));
      notificationTime.setSeconds(0);
      notificationTime.setMilliseconds(0);

      // Вычисляем время оповещения (2 часа до события)
      const notificationTimeBeforeEvent = new Date(notificationTime.getTime() - 2 * 60 * 60 * 1000);

      // Проверка, что время оповещения не должно быть в прошлом
      if (notificationTimeBeforeEvent > currentTime) {
        if (!scheduledNotifications[eventId]) {
          // Создание задачи для оповещения
          const job = schedule.scheduleJob(notificationTimeBeforeEvent, () => {
            const message = `Мы ждем Вас через 2 часа. Не забудьте!`;
            bot.sendMessage(chatId, message);
          });
          scheduledNotifications[eventId] = job;
        }
      }
    });
  });
}

//Функция изменения события в календаре
async function updateEvent(eventId, eventDetails) {
  try {
    const client = await getAuthorizedClient();
    const calendar = google.calendar({ version: 'v3', auth: client });

    const updatedEvent = {
      summary: eventDetails.summary,
      description: eventDetails.description,
      start: {
        dateTime: eventDetails.startDateTime,
        timeZone: 'Europe/Moscow',
      },
      end: {
        dateTime: eventDetails.endDateTime,
        timeZone: 'Europe/Moscow',
      },
    };

    const response = await calendar.events.update({
      calendarId: CALENDAR_ID,
      eventId: eventId,
      resource: updatedEvent,
    });

    return response.data;
  } catch (error) {
    console.error('Ошибка при обновлении события:', error);
  }
}

//Функция создания события в календаре
async function createEvent(eventDetails, chatId) {
  try {
    const client = await getAuthorizedClient();
    const calendar = google.calendar({ version: 'v3', auth: client });

    const event = {
      summary: eventDetails.summary,
      description: eventDetails.description,
      start: {
        dateTime: eventDetails.startDateTime,
        timeZone: 'Europe/Moscow',
      },
      end: {
        dateTime: eventDetails.endDateTime,
        timeZone: 'Europe/Moscow',
      },
    };

    const response = await calendar.events.insert({
      calendarId: CALENDAR_ID,
      resource: event,
    });

    const eventId = response.data.id;

    if (!eventsid[chatId]) {
      eventsid[chatId] = {};
    }

    eventsid[chatId].eventId = eventId;

    return eventId;
  } catch (error) {
    console.error('Ошибка создания события:', error);
  }
}


//Создание таблиц для хранения данных
db.run(`
  CREATE TABLE IF NOT EXISTS reservations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chatId INTEGER NOT NULL,
    Имя TEXT NOT NULL,
    Телефон TEXT NOT NULL,
    Гос_номер TEXT NOT NULL,
    Марка_авто TEXT NOT NULL,
    Услуга TEXT NOT NULL,
    Дата TEXT NOT NULL,
    Время TEXT NOT NULL,
    Статус TEXT DEFAULT 'Ожидание',
    Комментарий TEXT DEFAULT '-'
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS users (
    chatId INTEGER PRIMARY KEY,
    Имя TEXT,
    Номер_телефона TEXT,
    Гос_номер TEXT,
    Модель_авто TEXT
  )
  `)

let userId, name, phone, numbervehicle, vehicle, crash, date, time, comment;
let bookingId;
const userEditReservadm = {};
//Логика обработки админ-клавиатуры 
bot.on('callback_query', async (query) => {

  if (query.message.chat.id === AdminchatId) {
    const callbackdata = query.data;
  }
  const messageId = query.message.message_id;
  const { data, message } = query;
  const statusToCheck = ['Ожидание', 'Одобрено'];
  const [command, bookingId] = data.split('_');

  if (command === 'approve') { //Нажатие на кнопку подтверждения
  const messageIdadm = sentMessages[bookingId];
      db.run("UPDATE reservations SET Статус = 'Одобрено' WHERE id = ?", [bookingId], (error) => {
        if (error) { //Обновление статуса в таблице
          console.error('Ошибка при обновлении данных в таблице: ', error);
        }
      });
      //Кнопка завершения заявки
      const completebutton = {
        reply_markup: {
          inline_keyboard: [
            [{ text: 'Завершить', callback_data: `complete_${bookingId}` }],
            [{ text: 'Написать сообщение', callback_data: `answeradmin_${bookingId}` }],
            ]
        },
        parse_mode: 'HTML'
      };
      delete sentMessages[bookingId];
      bot.sendMessage(AdminchatId, `Заявка №${bookingId} \nЗапись на ремонт \nОдобрена ✅ \n\nДанные пользователя: \n\n` +
        `Имя клиента: ${reservationsData[bookingId].name}\n` +
        `Телефон пользователя: ${reservationsData[bookingId].phone}\n` +
        `Гос-номер: ${reservationsData[bookingId].numbervehicle}\n` +
        `Марка авто: ${reservationsData[bookingId].vehicle}\n` +
        `Услуга: ${reservationsData[bookingId].crash}\n` +
        `Дата: ${reservationsData[bookingId].date}\n` +
        `Время: ${reservationsData[bookingId].time}\n` +
        `Комментарий: ${reservationsData[bookingId].comment}`, completebutton)
        .then ((sentMessage) => {
          const messageId = sentMessage.message_id;
          sentMessages[bookingId] = messageId;
          if (query.message) {
              bot.deleteMessage(query.message.chat.id, query.message.message_id);
            }
          });
      const status = 'Одобрено';
      notifyUser(reservationsData[bookingId].userId, status, bookingId);
  } else if (command === 'reject') { //Нажатие на кнопку отклонения
      db.run("UPDATE reservations SET Статус = 'Отклонено' WHERE id = ?", [bookingId], (error) => {
        if (error) { //Обновление статуса в таблице
          console.error('Ошибка при обновлении данных в таблице: ', error);
        }
      });
      bot.sendMessage(AdminchatId, `Заявка №${bookingId} \nЗапись на ремонт \nОтклонена ❌ \n\nДанные пользователя: \n\n` +
        `Имя клиента: ${reservationsData[bookingId].name}\n` +
        `Телефон пользователя: ${reservationsData[bookingId].phone}\n` +
        `Гос-номер: ${reservationsData[bookingId].numbervehicle}\n` +
        `Марка авто: ${reservationsData[bookingId].vehicle}\n` +
        `Услуга: ${reservationsData[bookingId].crash}\n` +
        `Дата: ${reservationsData[bookingId].date}\n` +
        `Время: ${reservationsData[bookingId].time}\n` +
        `Комментарий: ${reservationsData[bookingId].comment}`)
        .then ((sentMessage) => {
          const messageId = sentMessage.message_id;
          if (query.message) {
              bot.deleteMessage(query.message.chat.id, query.message.message_id);
            }
          });
      const status = 'Отклонено';
      const chatId = reservationsData[bookingId].userId;
      const eventId = eventsid[chatId]?.eventId;
      deleteEvent(eventId);
      notifyUser(reservationsData[bookingId].userId, status, bookingId);
      delete eventsid[chatId];
      delete reservationsData[bookingId];
  } else if (command === 'complete') { //Нажатие на кнопку заверешения заказа
      const messageId = sentMessages[bookingId];
      db.run("UPDATE reservations SET Статус = 'Завершено' WHERE id = ?", [bookingId], (error) => {
        if (error) { //Обновление статуса в таблице
          console.error('Ошибка при обновлении данных в таблице: ', error);
        }
      });
      delete sentMessages[bookingId];
      bot.sendMessage(AdminchatId, `Заявка №${bookingId} \nЗапись на ремонт \nЗавершена 💯 \n\nДанные пользователя: \n\n` +
        `Имя клиента: ${reservationsData[bookingId].name}\n` +
        `Телефон пользователя: ${reservationsData[bookingId].phone}\n` +
        `Гос-номер: ${reservationsData[bookingId].numbervehicle}\n` +
        `Марка авто: ${reservationsData[bookingId].vehicle}\n` +
        `Услуга: ${reservationsData[bookingId].crash}\n` +
        `Дата: ${reservationsData[bookingId].date}\n` +
        `Время: ${reservationsData[bookingId].time}\n` +
        `Комментарий: ${reservationsData[bookingId].comment}`)
        .then ((sentMessage) => {
          const messageId = sentMessage.message_id;
          if (query.message) {
              bot.deleteMessage(query.message.chat.id, query.message.message_id);
            }
          });

      const chatId = reservationsData[bookingId].userId;
      const status = 'Завершено';
      const eventId = eventsid[chatId]?.eventId;
      deleteEvent(eventId);
      notifyUser(reservationsData[bookingId].userId, status, bookingId);
      delete eventsid[chatId];
      delete reservationsData[bookingId];
  } else if (command === 'answeradmin') {
    currentBookingId = bookingId;
    const userId = reservationsData[bookingId].userId;
    if (!adminanswer[bookingId]){
      adminanswer[bookingId] = {};
    }
    adminanswer[bookingId].step = "comment";
    bot.sendMessage(AdminchatId, 'О чем Вы хотите рассказать пользователю?');

    bot.on('message', async (msg) => {
      const messageText = msg.text;
      if (adminanswer[bookingId] && adminanswer[bookingId].step === "comment") {
    const bookingId = currentBookingId;
    adminanswer[bookingId].comment = messageText;
    bot.sendMessage(reservationsData[bookingId].userId, adminanswer[bookingId].comment, menubuttonadmcom);
    bot.sendMessage(AdminchatId, 'Сообщение успешно отправлено!')
    delete adminanswer[bookingId];
    }
  });

  } else if (command === 'redatefromadmin') {
    const userId = reservationsData[bookingId].userId;
    if (!userEditReservadm[userId]) {
      userEditReservadm[userId] = {};
    }

    if (!userEditReservadm[userId].date) {
    const datesKB = {
      inline_keyboard: matrixdate.map(dateRow => dateRow.map(dateObj => ({
        text: moment(dateObj.originalDate).format('DD.MM'), // Используем исходную дату из объекта dateObj          
        callback_data: `datte${dateObj.date}_${bookingId}`, // Используем отформатированную дату для callback_data
        }))),
      };

    bot.sendMessage(AdminchatId, "Выберите дату:", { reply_markup: { ...datesKB, one_time_keyboard: true } });
  }
  } else if (data.startsWith("datte")) {
  const [command, bookingId] = data.split('_');
  const userId = reservationsData[bookingId].userId;
  const selectedDate = data.split('_')[0].substring(5);

  if (userEditReservadm[userId]) {
    userEditReservadm[userId].date = selectedDate;
  }

  // Удаление предыдущего сообщения с кнопками
  bot.deleteMessage(AdminchatId, messageId).catch(error => console.log("Error deleting message:", error));

  // Предложение выбора времени
  getAvailableTimeSlots(selectedDate).then((keyboardMatrix) => {
    if (keyboardMatrix.length === 0) {
      const datesKB = {
        inline_keyboard: matrixdate.map(dateRow => dateRow.map(dateObj => ({
          text: moment(dateObj.originalDate).format('DD.MM'), //Используем исходную дату из объекта dateObj
          callback_data: `datte${dateObj.date}_${bookingId}`, //Используем отформатированную дату для callback_data
        }))),
      };
      //Если нет доступных слотов, отправляем сообщение о занятости
      bot.sendMessage(AdminchatId, "На этот день все слоты заняты. Выберите другой день", { reply_markup: { ...datesKB, one_time_keyboard: true } });
    } else {
      //Иначе, предложение выбора времени с клавиатурой
      const timesKB = {
        inline_keyboard: keyboardMatrix.map((row) =>
          row.map((time) => ({
            text: time,
            callback_data: `timme${time}_${bookingId}`,
          }))
        ),
      };
  bot.sendMessage(AdminchatId, "Выберите время:", { reply_markup: { ...timesKB, one_time_keyboard: true } });
    }
  });
} else if (data.startsWith("timme")) {
  const [command, bookingId] = data.split('_');
  const userId = reservationsData[bookingId].userId;
  const selectedTime = data.split('_')[0].substring(5);

  if (userEditReservadm[userId]) {
    userEditReservadm[userId].time = selectedTime;
  }

  db.run('UPDATE reservations SET Дата = ?, Время = ? WHERE chatId = ? AND Статус IN (?, ?)', [userEditReservadm[userId].date, userEditReservadm[userId].time, userId, ...statusToCheck], function(err) {
    if (err) {
      return console.error('Ошибка!');
    }
  });
  // Удаление предыдущего сообщения с кнопками
  bot.deleteMessage(AdminchatId, messageId).catch(error => console.log("Error deleting message:", error));
  delete userEditReserv[userId];
    db.all('SELECT * FROM reservations WHERE Статус IN (?, ?) AND chatId = ?', 
      [...statusToCheck, userId],
      (err, rows) => {
        if(err) {
          console.error('Ошибка при выполнении запроса!');
          return;
      }
    });
      delete tempMsgEditRes[userId];
      SendChangeAdmin(userId);
      SendChangeUser(userId);
  }
});

//Функция оповещения об изменениях со стороны администрации
async function SendChangeUser(userId) {
const statusToCheck = ['Ожидание', 'Одобрено'];
    db.all('SELECT * FROM reservations WHERE Статус IN (?, ?) AND chatId = ?', 
    [...statusToCheck, userId],
    (err, rows) => {
      if(err) {
        console.error('Ошибка при выполнении запроса!');
        return;
     }

  rows.forEach((row) => {
    const id = row.id;
    const status = row.Статус;
    const name = row.Имя;
    const phone = row.Телефон;
    const crash = row.Услуга;
    const vehicle = row.Марка_авто;
    const numbervehicle = row.Гос_номер;
    const date = row.Дата;
    const time = row.Время;
    const comment = row.Комментарий;

    editreservmsgtoUser = `Вынуждены были внести изменения в Вашу бронь №${id}!\n` +
    `Статус: ${status}\n\n` +
    `Имя клиента: ${name}\n` +
    `Телефон клиента: ${phone}\n` +
    `Выбранная услуга: ${crash}\n` +
    `Марка авто: ${vehicle}\n` +
    `Гос. номер авто: ${numbervehicle}\n` +
    `Дата: ${date}\n` +
    `Время: ${time}\n` +
    `Комментарий: ${comment}`;
  });
    bot.sendMessage(userId, editreservmsgtoUser);
 });
}

//Функция оповещения об изменениях со стороны пользователея
async function SendChangeAdmin(chatId) {
  const statusToCheck = ['Ожидание', 'Одобрено'];
    db.all('SELECT * FROM reservations WHERE Статус IN (?, ?) AND chatId = ?', 
    [...statusToCheck, chatId],
    (err, rows) => {
      if(err) {
        console.error('Ошибка при выполнении запроса!');
        return;
     }

  rows.forEach((row) => {
    const id = row.id;
    const chatId = row.userid;
    const status = row.Статус;
    const name = row.Имя;
    const phone = row.Телефон;
    const crash = row.Услуга;
    const vehicle = row.Марка_авто;
    const numbervehicle = row.Гос_номер;
    const date = row.Дата;
    const time = row.Время;
    const comment = row.Комментарий;

    editreservmsgtoAdm = `Изменения по брони №${id}!\n` +
    `Статус: ${status}\n\n` +
    `Имя клиента: ${name}\n` +
    `Телефон клиента: ${phone}\n` +
    `Выбранная услуга: ${crash}\n` +
    `Марка авто: ${vehicle}\n` +
    `Гос. номер авто: ${numbervehicle}\n` +
    `Дата: ${date}\n` +
    `Время: ${time}\n` +
    `Комментарий: ${comment}`;

    const eventDate = moment(date, 'DD:MM').format('YYYY-MM-DD');
    const eventTime = moment(time, 'HH:mm').format('HH:mm:ss');
    const eventEndTime = moment(time, 'HH:mm').add(1, 'hour').format('HH:mm:ss');

    updatedEvent = {
      summary: `Запись на ремонт автомобиля: ${vehicle}`,
      description: `Услуга: ${crash}\nДата: ${date}\nВремя: ${time}`,
      startDateTime: `${eventDate}T${eventTime}`,
      endDateTime: `${eventDate}T${eventEndTime}`,
     };
  });
    const eventId = eventsid[chatId]?.eventId;
    updateEvent(eventId, updatedEvent);
    bot.sendMessage(AdminchatId, editreservmsgtoAdm);
 });
}

//Функция уведомления об отмене
async function SendRejectAdmin(chatId) {
  const statusToCheck = ['Отменено'];
    db.all('SELECT * FROM reservations WHERE Статус IN (?) AND chatId = ?', 
    [...statusToCheck, chatId],
    (err, rows) => {
      if(err) {
        console.error('Ошибка при выполнении запроса!');
        return;
     }

  rows.forEach((row) => {
    const id = row.id;
    const phone = row.Телефон;
    const name = row.Имя;
    const comment = row.Комментарий;

    rejreservmsgtoAdm = `Запись №${id} была отменена пользователем \n\n` +
    `Имя пользователя: ${name} \n` +
    `Телефон: ${phone} \n` +
    `Комментарий: ${comment}`;
  });
    bot.sendMessage(AdminchatId, rejreservmsgtoAdm);
 });
}

//Функция уведомления о добавлении комментария
async function SendCommentAdmin(chatId) {
  const statusToCheck = ['Ожидание', 'Одобрено', 'Отменено'];
    db.all('SELECT * FROM reservations WHERE Статус IN (?, ?, ?) AND chatId = ?', 
    [...statusToCheck, chatId],
    (err, rows) => {
      if(err) {
        console.error('Ошибка при выполнении запроса!');
        return;
     }

  rows.forEach((row) => {
    const id = row.id;
    const phone = row.Телефон;
    const name = row.Имя;
    const comment = row.Комментарий;

    commreservmsgtoAdm = `Пользователь добавил комментарий к записи №${id}\n\n` +
    `Имя пользователя: ${name} \n` +
    `Телефон: ${phone} \n` +
    `Комментарий: ${comment}`;
  });
    bot.sendMessage(AdminchatId, commreservmsgtoAdm);
 });
}

//Функция проверки и оповещения о новых заявках
function checkNewreserv() {
    db.serialize(() => {
      db.each("SELECT * FROM reservations WHERE Статус = 'Ожидание'", (error, row) => {
        if (error) {
          console.error('Ошибка поиска для админ панели: ', error)
          return;
        }

      userId = row.chatId; //ChatID юзера
      name = row.Имя; //Имя пользователя
      bookingId = row.id; //Порядковый номер заявки
      phone = row.Телефон; //Телефон пользователя
      numbervehicle = row.Гос_номер; //Гос-номер авто
      vehicle = row.Марка_авто; //Марка авто
      crash = row.Услуга; //Услуга
      date = row.Дата; //Дата брони
      time = row.Время; //Время брони
      comment = row.Комментарий; //Комментарий

    reservationsData[bookingId] = {
      userId: userId, //ChatID юзера
      name: name, //Имя пользователя
      bookingId: bookingId, //Порядковый номер заявки
      phone: phone, //Телефон пользователя
      numbervehicle: numbervehicle, //Гос-номер авто
      vehicle: vehicle, //Марка авто
      crash: crash, //Услуга
      date: date, //Дата брони
      time: time, //Время брони
      comment: comment, //Комментарий
    };

  if (sentMessages[bookingId]) {
    return;
  }

    //Админ-клавиатура
  const adminbut = [
    [{ text: '✅ Одобрить заявку! ', callback_data: `approve_${bookingId}`}],
    [{ text: '❌ Отклонить заявку!', callback_data: `reject_${bookingId}`}],
    [{ text: 'Ответить пользователю', callback_data: `answeradmin_${bookingId}`}],
    [{ text: 'Изменить дату и время брони', callback_data: `redatefromadmin_${bookingId}`}],
    ];

    const adminkeybord = {
      inline_keyboard: adminbut,
    };

  //Отправка сообщения о новой заявке
  bot.sendMessage(AdminchatId, `Бронь №${bookingId} \nНовая бронь! \n\nДанные пользователя: \n\n` +
    `Имя клиента: ${name}\n` +
    `Телефон пользователя: ${phone}\n` +
    `Гос-номер: ${numbervehicle}\n` +
    `Марка авто: ${vehicle}\n` +
    `Услуга: ${crash}\n` +
    `Дата: ${date}\n` +
    `Время: ${time}`, {reply_markup: adminkeybord})
  .then((sentMessage) => {
    sentMessages[bookingId] = sentMessage.message_id; //Сохранение идентификатора сообщения
      });
    });
  });
}

//Функция уведомления пользователя о статусе заявки
function notifyUser(chatId, status, bookingId) {
  let messagest;
  if (status === 'Одобрено') {
    messagest = `Заявка №${bookingId} \nЗапись на ремонт \nОдобрена ✅\n\n` +
    `Гос-номер: ${reservationsData[bookingId].numbervehicle}\n` +
    `Марка авто: ${reservationsData[bookingId].vehicle}\n` +
    `Услуга: ${reservationsData[bookingId].crash}\n` +
    `Дата: ${reservationsData[bookingId].date}\n` +
    `Время: ${reservationsData[bookingId].time}`;
  } else if (status === 'Отклонено') {
    messagest = `Заявка №${bookingId} \nЗапись на ремонт \nОтклонена ❌\n\n` +
    `Гос-номер: ${reservationsData[bookingId].numbervehicle}\n` +
    `Марка авто: ${reservationsData[bookingId].vehicle}\n` +
    `Услуга: ${reservationsData[bookingId].crash}\n` +
    `Дата: ${reservationsData[bookingId].date}\n` +
    `Время: ${reservationsData[bookingId].time}`;
  } else if (status === 'Завершено') {
    messagest = `Спасибо за посещения нашего сервиса! \n` +
    `Ни гвоздя, ни жезла!`;
  }
  bot.sendMessage(chatId, messagest, menubutton);
}

//Функция для очистки состояния пользователя
function clearUserState(chatId) {
  delete userState[chatId];
}

//Функция первого сообщения
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  if (!userState[chatId]) {
    userState[chatId] = { step: "phone" };
    requestContact(chatId);
  } else {
    bot.sendMessage(chatId, 'Вы уже начали заполнение данных. Продолжайте с предыдущего шага или введите /start, чтобы начать сначала.');
  }
});

//Обработчик сообщения команды старт
bot.on('contact', (msg) => {
  const chatId = msg.chat.id;
  handleUserStep(chatId, null, msg.contact);
});


bot.on('message', (msg) => {
  const chatId = msg.chat.id;
  handleUserStep(chatId, msg.text, null);
});

//Функция запроса контакта
async function requestContact(chatId) {
  const startmsg = "Добро пожаловать! Для продолжения работы, нам нужен Ваш номер!";
  const keyphoneKB = {
    keyboard:[
      [{text: 'Отправить контакт', request_contact: true}],
    ],
    resize_keyboard: true,
    one_time_keyboard: true
  };

  bot.sendMessage(chatId, startmsg, { reply_markup: keyphoneKB })
    .then(() => {
      userState[chatId].step = "phone";
    })
    .catch((error) => {
      console.error('Ошибка при отправке сообщения: ', error);
    });
}


//Функция для обработки текущего шага пользователя
async function handleUserStep(chatId, input, contact) {
  const state = userState[chatId];
  if (!state) {
    return;
  }
  
  switch (state.step) {
    case "phone":
      if (input) {
        // Обработка ввода номера телефона
        userState[chatId].phone = input;
        userState[chatId].step = "name";
        bot.sendMessage(chatId, 'Как мы можем к Вам обращаться?');
      } else if (contact && contact.phone_number) {
        // Обработка карточки телефона
        userState[chatId].phone = contact.phone_number;
        userState[chatId].step = "name";
        bot.sendMessage(chatId, 'Как мы можем к Вам обращаться?', {reply_markup: {hide_keyboard: true }});
      } 
      break;
    case "name":
      // Обработка ввода имени
      userState[chatId].name = input;
      userState[chatId].step = "numbercar";
      bot.sendMessage(chatId, 'Укажите Гос-номер Вашего авто в формате "А111АА111"');
      break;
    case "numbercar":
      // Обработка ввода номера авто
      userState[chatId].numbercar = input;
      userState[chatId].step = "modelcar";
      bot.sendMessage(chatId, 'Укажите марку Вашего авто');
      break;
    case "modelcar":
      // Обработка ввода марки авто
      userState[chatId].modelcar = input;
      // Все данные получены, можно сохранить в базе данных
      const { name, phone, numbercar, modelcar } = userState[chatId];
      const dataSaved = true;
      saveUserDataToDatabase(chatId, name, phone, numbercar, modelcar);
      if (dataSaved) {
        bot.sendMessage(chatId, 'Спасибо, теперь Вы можете продолжить работу с ботом! \nЕсли Вам нужно изменить какие-то данные, Вы можете заполнить эти данные заново, воспользовавшись командой /start!', menubutton);
        // Очистить состояние пользователя
        clearUserState(chatId);
      } 
      break;
    default:
      // Неизвестный шаг или ошибка
      bot.sendMessage(chatId, 'Извините, произошла ошибка. Пожалуйста, начните снова с команды /start.');
      // Очистить состояние пользователя
      delete userState[chatId];
      break;
  }
}

// Функция для сохранения данных в базе данных
async function saveUserDataToDatabase(chatId, name, phone, numbercar, modelcar) {
const insertQuery = `
    REPLACE INTO users (chatId, Имя, Номер_телефона, Гос_номер, Модель_авто)
    VALUES (?, ?, ?, ?, ?)
  `;

const values = [chatId, userState[chatId].name, userState[chatId].phone, userState[chatId].numbercar, userState[chatId].modelcar];
db.run(insertQuery, values, function(err) {
  if (err) {
    console.error('Ошибка при вставке данных: ', err);
    return;
  }
  console.log('Данные в таблице');
  startdataSaved = true;
});
}

//Функция рассылки
bot.onText(/\/sentallmessage/, (msg) =>{
  const chatId = msg.chat.id;
  const getAllChatIdsQuery = 'SELECT chatId FROM users';
  bot.sendMessage(chatId, 'Введите сообщение для рассылки: ');
  bot.once('message', (message) => {
    const text = message.text;

    db.all(getAllChatIdsQuery, [], (err, rows) => {
    if (err) {
      console.error('Ошибка при выполнении запроса: ', err);
      return;
    }

    rows.forEach((row) => {
      const chatId = row.chatId;
      bot.sendMessage(chatId, text);
    });
   });
    bot.sendMessage(AdminchatId, 'Рассылка отправлена!');
  })
})

//Функция отправки файла БД
bot.onText(/\/sendfileDB/, (msg) => {
  const chatId = msg.chat.id;
  functions.sendFileToAdmin(bot, AdminchatId, filepath, msg);
});

const userReserv = {}; //Создание объекта для временного хранения данных брони пользователей
const dates = functions.getNextNineDates(moment); //Создание массива ближайших 9 дат
const matrixdate = functions.createMatrixdate(dates); //Создание матрицы из ближайших 9 дат

//Массив предоставляемых услуг
const services = [
  "Замена масла в ДВС",
  "Замена масла МКПП/АКПП",
  "Аппаратная замена масла",
  "Ремонт глушителя",
  "Сварочные работы",
  "Ремонт подвески",
  "Ревизия суппортов",
  "Сварка пластика",
  "Чистка форсунок",
  "Поиск подсоса воздуха"
];

const buttonsedit = [
  [{ text: 'Изменить услугу', callback_data: 'editcrash' }],
  [{ text: 'Изменить дату и время', callback_data: 'editdate' }],
  [{ text: 'Добавить комментарий', callback_data: 'insertcomment' }],
  [{ text: 'Отменить бронь', callback_data: 'rejectreserv' }],
  [{ text: 'Меню', callback_data: 'mainmenu' }],
  ];

const keyboardedit = {
  inline_keyboard: buttonsedit,
};

const userEditReserv = {};

//Обработчик клавиатуры изменения брони
bot.on('callback_query', async (query) => {
  const messageIdadm = sentMessages[bookingId];
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const data = query.data;
  const MessagedelId = tempMsgEditRes[chatId];
  const statusToCheck = ['Ожидание', 'Одобрено'];

  if (data === 'editcrash') {

    if (!userEditReserv[chatId]) {
      userEditReserv[chatId] = {};
    }

    const servicesKB = {
      inline_keyboard: services.map(service => [{ text: service, callback_data: `editc_${service}` }]),
    };
    bot.sendMessage(chatId, "Выберите услугу:", { reply_markup: { ...servicesKB, one_time_keyboard: true } });
  } else if (data.startsWith("editc_")) {
  const crash = data.substring(6);

  if (userEditReserv[chatId]) {
    userEditReserv[chatId].crash = crash;
  }

  db.run('UPDATE reservations SET Услуга = ? WHERE chatId = ? AND Статус IN (?, ?)', [userEditReserv[chatId].crash, chatId, ...statusToCheck], function(err) {
    if (err) {
      return console.error('Ошибка!');
    }
  });

  // Удаление предыдущего сообщения с кнопками
  bot.deleteMessage(chatId, MessagedelId)
  bot.deleteMessage(chatId, messageId).catch(error => console.log("Error deleting message:", error));
  delete userEditReserv[chatId];
    db.all('SELECT * FROM reservations WHERE Статус IN (?, ?) AND chatId = ?', 
      [...statusToCheck, chatId],
      (err, rows) => {
        if(err) {
          console.error('Ошибка при выполнении запроса!');
          return;
      }

    rows.forEach((row) => {
      const status = row.Статус;
      const crash = row.Услуга;
      const vehicle = row.Марка_авто;
      const numbervehicle = row.Гос_номер;
      const date = row.Дата;
      const time = row.Время;
      const comment = row.Комментарий;

      editreservmsg = `Изменения успешны! \n` +
      `Статус: ${status}\n\n` +
      `Вы выбрали услугу: ${crash}\n` +
      `Марка авто: ${vehicle}\n` +
      `Гос. номер авто: ${numbervehicle}\n` +
      `Дата: ${date}\n` +
      `Время: ${time}\n` +
      `Комментарий: ${comment}\n\n` +
      `Вы можете редактировать заявку ниже`;
      });
      delete tempMsgEditRes[chatId];
      bot.sendMessage(chatId, editreservmsg, { reply_markup: keyboardedit })
      .then((sentMessage) => {
      tempMsgEditRes[chatId] = sentMessage.message_id; //Сохранение идентификатора сообщения
    });
   });
  SendChangeAdmin(chatId);
  } else if (data === 'editdate') {

    if (!userEditReserv[chatId]) {
      userEditReserv[chatId] = {};
    }

    if (!userEditReserv[chatId].date) {
    const datesKB = {
      inline_keyboard: matrixdate.map(dateRow => dateRow.map(dateObj => ({
        text: moment(dateObj.originalDate).format('DD.MM'), // Используем исходную дату из объекта dateObj          
        callback_data: `datee${dateObj.date}`, // Используем отформатированную дату для callback_data
        }))),
      };

    bot.sendMessage(chatId, "Выберите дату:", { reply_markup: { ...datesKB, one_time_keyboard: true } });
  }
  } else if (data.startsWith("datee")) {
  const selectedDate = data.substring(5);

  if (userEditReserv[chatId]) {
    userEditReserv[chatId].date = selectedDate;
  }

  // Удаление предыдущего сообщения с кнопками
  bot.deleteMessage(chatId, messageId).catch(error => console.log("Error deleting message:", error));

  // Предложение выбора времени
  getAvailableTimeSlots(selectedDate).then((keyboardMatrix) => {
    if (keyboardMatrix.length === 0) {
      const datesKB = {
        inline_keyboard: matrixdate.map(dateRow => dateRow.map(dateObj => ({
          text: moment(dateObj.originalDate).format('DD.MM'), //Используем исходную дату из объекта dateObj
          callback_data: `datee${dateObj.date}`, //Используем отформатированную дату для callback_data
        }))),
      };
      //Если нет доступных слотов, отправляем сообщение о занятости
      bot.sendMessage(chatId, "На этот день все слоты заняты. Выберите другой день", { reply_markup: { ...datesKB, one_time_keyboard: true } });
    } else {
      //Иначе, предложение выбора времени с клавиатурой
      const timesKB = {
        inline_keyboard: keyboardMatrix.map((row) =>
          row.map((time) => ({
            text: time,
            callback_data: `timee${time}`,
          }))
        ),
      };
  bot.sendMessage(chatId, "Выберите время:", { reply_markup: { ...timesKB, one_time_keyboard: true } });
    }
  });
} else if (data.startsWith("timee")) {
  const selectedTime = data.substring(5);

  if (userEditReserv[chatId]) {
    userEditReserv[chatId].time = selectedTime;
  }

  db.run('UPDATE reservations SET Дата = ?, Время = ? WHERE chatId = ? AND Статус IN (?, ?)', [userEditReserv[chatId].date, userEditReserv[chatId].time, chatId, ...statusToCheck], function(err) {
    if (err) {
      return console.error('Ошибка!');
    }
  });

  // Удаление предыдущего сообщения с кнопками
  bot.deleteMessage(chatId, MessagedelId);
  bot.deleteMessage(chatId, messageId).catch(error => console.log("Error deleting message:", error));
  delete userEditReserv[chatId];
    db.all('SELECT * FROM reservations WHERE Статус IN (?, ?) AND chatId = ?', 
      [...statusToCheck, chatId],
      (err, rows) => {
        if(err) {
          console.error('Ошибка при выполнении запроса!');
          return;
      }

    rows.forEach((row) => {
      const status = row.Статус;
      const crash = row.Услуга;
      const vehicle = row.Марка_авто;
      const numbervehicle = row.Гос_номер;
      const date = row.Дата;
      const time = row.Время;
      const comment = row.Комментарий;

      editreservmsg = `Изменения успешны! \n` +
      `Статус: ${status}\n\n` +
      `Вы выбрали услугу: ${crash}\n` +
      `Марка авто: ${vehicle}\n` +
      `Гос. номер авто: ${numbervehicle}\n` +
      `Дата: ${date}\n` +
      `Время: ${time}\n` +
      `Комментарий: ${comment}\n\n` +
      `Вы можете редактировать заявку ниже`;
    });
      delete tempMsgEditRes[chatId];
      bot.sendMessage(chatId, editreservmsg, { reply_markup: keyboardedit })
      .then((sentMessage) => {
      tempMsgEditRes[chatId] = sentMessage.message_id; //Сохранение идентификатора сообщения
    });
   });
  SendChangeAdmin(chatId);
  } else if (data === 'insertcomment') {

      if (!userEditReserv[chatId]) {
      userEditReserv[chatId] = {};
    }

    userEditReserv[chatId].step = "comment";
    bot.sendMessage(chatId, 'Расскажите подробнее о Вашей проблеме:');
  } else if (data === 'rejectreserv') {
    db.run('UPDATE reservations SET Статус = "Отменено" WHERE chatId = ?', [chatId], function(err) {
      if (err) {
        return console.error('Ошибка!');
      }
    });

    const rejectKB = {
      inline_keyboard: [
        [{ text: 'Вернуться к меню', callback_data: 'mainmenu' }],
        [{ text: 'Оставить комментарий', callback_data: 'insertcommentrej' }],
      ]
    };
    bot.deleteMessage(chatId, MessagedelId);
    bot.deleteMessage(AdminchatId, messageIdadm) //Удаление старого сообщения
      .catch((error) => {
      console.error('Ошибка при попытке удалить сообщение:', error);
      });
      delete sentMessages[bookingId]; //Удаление идентификатора заявки из объекта
    bot.sendMessage(chatId, 'Ваша бронь отменена, не хотите ли оставить комментарий?', { reply_markup: rejectKB })
      .then((sentMessage) => {
      tempMsgEditRes[chatId] = sentMessage.message_id; //Сохранение идентификатора сообщения
    });
    SendRejectAdmin(chatId);
    const eventId = eventsid[chatId]?.eventId;
    deleteEvent(eventId);
  } else if (data === 'insertcommentrej') {

      if (!userEditReserv[chatId]) {
      userEditReserv[chatId] = {};
    }
    bot.deleteMessage(chatId, MessagedelId);
    userEditReserv[chatId].step = "commentrej";
    bot.sendMessage(chatId, 'Почему Вы отменили бронь?');
  }
})

//Обработчик клавиатуры брони
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const data = query.data;

  if (data === 'reserv') {
  const statusToCheck = ['Ожидание', 'Одобрено'];

 db.get(
    `SELECT COUNT(*) AS count FROM reservations WHERE Статус IN (?, ?) AND chatId = ?`, 
    [...statusToCheck, chatId], 
    function(err, row) {
      if (err) {
        return console.error('Ошибка');
      }
      const count = row.count;

      if (count > 0) {
        bot.sendMessage(chatId, 'У вас уже есть активная бронь, для начала разберитесь с ней!', menubutton);
      } else {

    if (!userReserv[chatId]) {
      userReserv[chatId] = {};
    }

    db.all('SELECT * FROM users WHERE chatId = ?', [chatId], (err, rows) => {
      if (err) {
        console.error('Ошибка при выполнении запроса:', err.message);
        return;
      }

      rows.forEach((row) => {
        const name = row.Имя;
        const phone = row.Номер_телефона;
        const numbervehicle = row.Гос_номер;
        const vehicle = row.Модель_авто;

        userReserv[chatId].name = name;
        userReserv[chatId].phone = phone;
        userReserv[chatId].numbervehicle = numbervehicle;
        userReserv[chatId].vehicle = vehicle;
      });

    const userData = userReserv[chatId];

    if (!userData.crash) {
      // Предложение выбора услуги
      const servicesKB = {
        inline_keyboard: services.map(service => [{ text: service, callback_data: `crash_${service}` }]),
      };
      bot.sendMessage(chatId, "Выберите услугу:", { reply_markup: { ...servicesKB, one_time_keyboard: true } })
      .then((sentMessage) => {
          if (query.message) {
        bot.deleteMessage(query.message.chat.id, query.message.message_id);
      }
  });
      userData.step = "crash";
    } else if (!userData.date) {
  // Предложение выбора даты
      const datesKB = {
        inline_keyboard: matrixdate.map(dateRow => dateRow.map(dateObj => ({
          text: moment(dateObj.originalDate).format('DD.MM'), // Используем исходную дату из объекта dateObj
          callback_data: `date_${dateObj.date}`, // Используем отформатированную дату для callback_data
        }))),
      };

      bot.sendMessage(chatId, "Выберите дату:", { reply_markup: { ...datesKB, one_time_keyboard: true } });
      userData.step = "date";
    }
    });
  }
  });
    } else if (data.startsWith("vehicle_")) {
    const vehicle = data.substring(8);

    if (userReserv[chatId]) {
      userReserv[chatId].vehicle = vehicle;
    }

    // Удаление предыдущего сообщения с кнопками
    bot.deleteMessage(chatId, messageId).catch(error => console.log("Error deleting message:", error));

    // Предложение выбора услуги
    const servicesKB = {
      inline_keyboard: services.map(service => [{ text: service, callback_data: `crash_${service}` }]),
    };
    bot.sendMessage(chatId, "Выберите услугу:", { reply_markup: { ...servicesKB, one_time_keyboard: true } });
} else if (data.startsWith("crash_")) {
  const crash = data.substring(6);

  if (userReserv[chatId]) {
    userReserv[chatId].crash = crash;
  }

  // Удаление предыдущего сообщения с кнопками
  bot.deleteMessage(chatId, messageId).catch(error => console.log("Error deleting message:", error));

  // Проверяем наличие всех необходимых данных перед предложением выбора даты
  if (userReserv[chatId]?.numbervehicle && userReserv[chatId]?.vehicle && userReserv[chatId]?.crash) {
    // Предложение выбора даты
  const datesKB = {
        inline_keyboard: matrixdate.map(dateRow => dateRow.map(dateObj => ({
          text: moment(dateObj.originalDate).format('DD.MM'), //Используем исходную дату из объекта dateObj
          callback_data: `date_${dateObj.date}`, //Используем отформатированную дату для callback_data
        }))),
      };

      bot.sendMessage(chatId, "Выберите дату:", { reply_markup: { ...datesKB, one_time_keyboard: true } });
  } else {
    bot.sendMessage(chatId, "Вы не выбрали все необходимые данные. Пожалуйста, завершите выбор марки авто, услуги и даты.");
  }
} else if (data.startsWith("date_")) {
  const selectedDate = data.substring(5);

  if (userReserv[chatId]) {
    userReserv[chatId].date = selectedDate;
  }

  // Удаление предыдущего сообщения с кнопками
  bot.deleteMessage(chatId, messageId).catch(error => console.log("Error deleting message:", error));

  // Предложение выбора времени
  getAvailableTimeSlots(selectedDate).then((keyboardMatrix) => {
    if (keyboardMatrix.length === 0) {
      const datesKB = {
        inline_keyboard: matrixdate.map(dateRow => dateRow.map(dateObj => ({
          text: moment(dateObj.originalDate).format('DD.MM'), //Используем исходную дату из объекта dateObj
          callback_data: `date_${dateObj.date}`, //Используем отформатированную дату для callback_data
        }))),
      };
      //Если нет доступных слотов, отправляем сообщение о занятости
      bot.sendMessage(chatId, "На этот день все слоты заняты. Выберите другой день", { reply_markup: { ...datesKB, one_time_keyboard: true } });
    } else {
      //Иначе, предложение выбора времени с клавиатурой
      const timesKB = {
        inline_keyboard: keyboardMatrix.map((row) =>
          row.map((time) => ({
            text: time,
            callback_data: `time_${time}`,
          }))
        ),
      };
  bot.sendMessage(chatId, "Выберите время:", { reply_markup: { ...timesKB, one_time_keyboard: true } });
    }
  });
} else if (data.startsWith("time_")) {
  const selectedTime = data.substring(5);

  if (userReserv[chatId]) {
    userReserv[chatId].time = selectedTime;
  }

  // Удаление предыдущего сообщения с кнопками
  bot.deleteMessage(chatId, messageId).catch(error => console.log("Error deleting message:", error));

  // Проверяем наличие всех необходимых данных перед формированием сообщения
  if (userReserv[chatId]?.numbervehicle && userReserv[chatId]?.vehicle && userReserv[chatId]?.crash && userReserv[chatId]?.date && userReserv[chatId]?.time) {
    const { name, numbervehicle, vehicle, crash, date, time, phone } = userReserv[chatId];
    const message = `Вы выбрали услугу: ${userReserv[chatId].crash}\n` +
    `Марка авто: ${userReserv[chatId].vehicle}\n` +
    `Гос. номер авто: ${userReserv[chatId].numbervehicle}\n` +
    `Дата: ${userReserv[chatId].date}\n` +
    `Время: ${userReserv[chatId].time}\n\n` +
    `Вы можете изменить конкретные данные или оставить комментарий!`;
    const statuswait = 'Ожидание';
    const eventDate = moment(userReserv[chatId].date, 'DD:MM').format('YYYY-MM-DD');
    const eventTime = moment(userReserv[chatId].time, 'HH:mm').format('HH:mm:ss');
    const eventEndTime = moment(time, 'HH:mm').add(1, 'hour').format('HH:mm:ss');
    const eventDetails = {
    summary: `Запись на ремонт автомобиля: ${userReserv[chatId].vehicle}`,
    description: `Услуга: ${userReserv[chatId].crash}\nДата: ${userReserv[chatId].date}\nВремя: ${userReserv[chatId].time}`,
    startDateTime: `${eventDate}T${eventTime}`,
    endDateTime: `${eventDate}T${eventEndTime}`,
   };
    bot.sendMessage(chatId, message, { reply_markup: keyboardedit })
    .then((sentMessage) => {
      tempMsgEditRes[chatId] = sentMessage.message_id; //Сохранение идентификатора сообщения
    });

    createEvent(eventDetails, chatId);
    db.run(
    'INSERT INTO reservations (chatId, Имя, Телефон, Гос_номер, Марка_авто, Услуга, Дата, Время) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [chatId, name, phone, numbervehicle, vehicle, crash, date, time],
    function (err) {
      if (err) {
        return console.log('Ошибка при сохранении данных в базе данных:', err.message);
      }
      console.log('Данные успешно сохранены в базе данных. ID записи:', this.lastID);
    }
  );
        db.all('SELECT * FROM reservations WHERE Статус = ? AND chatId = ?', 
    [statuswait, chatId],
    (err, rows) => {
      if(err) {
        console.error('Ошибка при выполнении запроса!');
        return;
     }

  rows.forEach((row) => {
    const id = row.id;

    tempMsgEditResid[chatId] = id;
  });
 });
  // Очищаем данные пользователя после отправки сообщения
  delete userReserv[chatId];
  } else {
    bot.sendMessage(chatId, "Вы не выбрали все необходимые данные. Пожалуйста, завершите выбор марки авто, услуги, даты и времени.");
  }
}
});

//Обработчик основной клавиатуры
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const data = query.data;

  if (data === "editreserv") {
  const statusToCheck = ['Ожидание', 'Одобрено'];

  db.get(
    `SELECT COUNT(*) AS count FROM reservations WHERE Статус IN (?, ?) AND chatId = ?`, 
    [...statusToCheck, chatId], 
    function(err, row) {
      if (err) {
        return console.error('Ошибка');
      }

      let editreservmsg; //Сообщение с подгруженными данными
      const count = row.count;

      if (count > 0) {

        db.all('SELECT * FROM reservations WHERE Статус IN (?, ?) AND chatId = ?', 
          [...statusToCheck, chatId],
          (err, rows) => {
            if(err) {
              console.error('Ошибка при выполнении запроса!');
              return;
            }

      rows.forEach((row) => {
        const id = row.id;
        const status = row.Статус;
        const crash = row.Услуга;
        const vehicle = row.Марка_авто;
        const numbervehicle = row.Гос_номер;
        const date = row.Дата;
        const time = row.Время;
        const comment = row.Комментарий;

        tempMsgEditResid[chatId] = id;
        editreservmsg = ` У Вас есть активная запись! \nСтатус: ${status}\n\nВы выбрали услугу: ${crash}\nМарка авто: ${vehicle}\nГос. номер авто: ${numbervehicle}\nДата: ${date}\nВремя: ${time}\nКомментарий: ${comment}\n\nВы можете редактировать заявку ниже`;
      });

        bot.sendMessage(chatId, editreservmsg, { reply_markup: keyboardedit })
        .then((sentMessage) => {
        tempMsgEditRes[chatId] = sentMessage.message_id; //Сохранение идентификатора сообщения

          if (query.message) {
        bot.deleteMessage(query.message.chat.id, query.message.message_id);
        }
      });
        });
      } else {
        bot.sendMessage(chatId, "У вас нет активных записей!", menubutton)
        .then((sentMessage) => {
            if (query.message) {
        bot.deleteMessage(query.message.chat.id, query.message.message_id);
          }
        });
      }
    }
  );

} else if (data === "contact") {
  const sitelink = "https://carparts32.ru/";
  const maplink = "https://yandex.ru/maps/191/bryansk/?from=mapframe&l=trf%2Ctrfe&ll=34.328239%2C53.255758&mode=usermaps&source=mapframe&um=constructor%3A50f0f752aaee019deb0235d7c5de4ba493877157ec724d41903316e6ee349b81&utm_source=mapframe&z=15";
  const maincontactmessage = "Как с нами связаться? \n\n" +
  "Телефон для связи: +7 (995) 498-7717\n" +
  "Адрес: г. Брянск ул. Красноармейская ул., 115\n" +
  `Наш сайт: <a href="${sitelink}">Сайт</a> \n` +
  `Карта проезда: <a href="${maplink}">Я.Карты</a>`;
  bot.sendMessage(chatId, maincontactmessage, menubutton)
  .then((sentMessage) => {
      if (query.message) {
  bot.deleteMessage(query.message.chat.id, query.message.message_id);
    }
  });

} else if (data === "mainmenu") {
  if (tempMsgEditRes) {
  delete tempMsgEditRes[chatId];
}
  const menumsg = "Мастерская приветствует Вас! Что вы хотите сделать сейчас?";
  const buttonsmenu = [
    [{ text: 'Создать бронь', callback_data: 'reserv' }],
    [{ text: 'Моя бронь', callback_data: 'editreserv' }],
    [{ text: 'Контакты', callback_data: 'contact' }],
    ];

  const keyboardmenu = {
    inline_keyboard: buttonsmenu,
  };

  bot.sendMessage(chatId, menumsg, { reply_markup: keyboardmenu })
  .then ((sentMessage) => {
    const messageId = sentMessage.message_id;
    if (query.message) {
        bot.deleteMessage(query.message.chat.id, query.message.message_id);
      }
  });
} else if (data === "answerusertoadmin") {
  if (!userEditReserv[chatId]) {
    userEditReserv[chatId] = {};
  }

  userEditReserv[chatId].step = "answerusertoadmin";
  bot.sendMessage(chatId, "Введите сообщение для администратора:");
}
});


bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const messageText = msg.text;
  const MessagedelId = tempMsgEditRes[chatId];
  const statusToCheck = ['Ожидание', 'Одобрено'];
  const statusreject = 'Отменено';
  const id = tempMsgEditResid[chatId];

  if (userEditReserv[chatId] && userEditReserv[chatId].step === "comment") {
      if (msg.photo && msg.photo.length > 0) {
      // Обработчик фотографии и комментария
      const photo = msg.photo;
      const caption = msg.caption;
      userEditReserv[chatId].comment = caption;
      bot.sendPhoto(AdminchatId, photo[photo.length - 1].file_id);
    } else {
      userEditReserv[chatId].comment = messageText;
    }

  db.run('UPDATE reservations SET Комментарий = ? WHERE chatId = ? AND Статус IN (?, ?)', [userEditReserv[chatId].comment, chatId, ...statusToCheck], function(err) {
    if (err) {
      return console.error('Ошибка!');
    }
  });
  delete userEditReserv[chatId];
  bot.deleteMessage(chatId, MessagedelId);

    db.all('SELECT * FROM reservations WHERE Статус IN (?, ?) AND chatId = ?', 
      [...statusToCheck, chatId],
      (err, rows) => {
        if(err) {
          console.error('Ошибка при выполнении запроса!');
          return;
      }

    rows.forEach((row) => {
      const status = row.Статус;
      const crash = row.Услуга;
      const vehicle = row.Марка_авто;
      const numbervehicle = row.Гос_номер;
      const date = row.Дата;
      const time = row.Время;
      const comment = row.Комментарий;
      const chatId = row.userid;

      editreservmsg = ` Изменения успешны! \n` +
      `Статус: ${status}\n\n` +
      `Вы выбрали услугу: ${crash}\n` +
      `Марка авто: ${vehicle}\n` +
      `Гос. номер авто: ${numbervehicle}\n` +
      `Дата: ${date}\n` + 
      `Время: ${time}\n` +
      `Комментарий: ${comment}\n\n`+
      `Вы можете редактировать заявку ниже`;
    });
      delete tempMsgEditRes[chatId];
      SendCommentAdmin(chatId);
      bot.sendMessage(chatId, editreservmsg, { reply_markup: keyboardedit })
      .then((sentMessage) => {
      tempMsgEditRes[chatId] = sentMessage.message_id; //Сохранение идентификатора сообщения
    });
   });
  } else if (userEditReserv[chatId] && userEditReserv[chatId].step === "commentrej") {
    userEditReserv[chatId].commentrej = messageText;

    db.run('UPDATE reservations SET Комментарий = ? WHERE chatId = ? AND Статус = ? AND id = ?', [userEditReserv[chatId].commentrej, chatId, statusreject, id], function(err) {
    if (err) {
      return console.error('Ошибка!');
    }
  });
      delete userEditReserv[chatId];
      comentrejmes = `Спасибо! Мы обязательно станем лучше!`;
      delete tempMsgEditRes[chatId];
      delete tempMsgEditResid[chatId];
      SendCommentAdmin(chatId);
      bot.sendMessage(chatId, comentrejmes, menubutton);
  } else if (userEditReserv[chatId] && userEditReserv[chatId].step === "answerusertoadmin") {
    let answerusertoadminmsg;
      if (msg.photo && msg.photo.length > 0) {
      // Обработчик фотографии и комментария
      const photo = msg.photo;
      const caption = msg.caption;
      userEditReserv[chatId].answerusertoadmin = caption;
      bot.sendPhoto(AdminchatId, photo[photo.length - 1].file_id);
    } else {
      userEditReserv[chatId].answerusertoadmin = messageText;
    }

    const usermessage = userEditReserv[chatId].answerusertoadmin;
    db.all('SELECT * FROM reservations WHERE Статус IN (?, ?) AND chatId = ?', 
      [...statusToCheck, chatId],
      (err, rows) => {
        if(err) {
          console.error('Ошибка при выполнении запроса!');
          return;
      }

    rows.forEach((row) => {
      const bookingId = row.id;
      const name = row.Имя;

      answerusertoadminmsg = ` Пользователь ${name} дал свой ответ по заявке №${bookingId}:\n` +
      `${usermessage}`;
    });
      bot.sendMessage(AdminchatId, answerusertoadminmsg);
      bot.sendMessage(chatId, "Спасибо, сообщение отправлено!", menubutton);
   });
    delete userEditReserv[chatId];
  }
});

// Запуск бота
bot.on('polling_error', (error) => {
  console.log(error);
});

console.log('Бот запущен');
