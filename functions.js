//Функция проверки БД на данные
async function CheckUserDB(chatId, db, userStatuses) {
  const selectQuery = `
    SELECT chatId, Имя, Номер_телефона FROM users WHERE chatId = ?
  `;

 try {
    const row = await new Promise((resolve, reject) => {
      db.get(selectQuery, [chatId], (err, row) => {
        if (err) {
          reject(err);
        } else {
          resolve(row);
        }
      });
    });

    const userStatus = { firstuser: false };

    if (!row) {
      userStatus.firstuser = true;
      } else {
      userStatus.firstuser = false;
      }
    userStatuses[chatId] = userStatus;
    return userStatus;
} catch (error) {
  console.error('Ошибка при выполнении запроса: ', error.message);
  }
}

//Функция отправки файла БД администратору
async function sendFileToAdmin (bot, AdminchatId, filepath, msg) {
    bot.sendDocument(AdminchatId, filepath)
    bot.sendMessage(AdminchatId, "Обновленный файл базы данных клиентов!");
    return;
  }


//Функция для получения даты завтрашнего дня
function getTomorrow(moment) {
  const tomorrow = moment().tz('Europe/Moscow').add(1, 'day').startOf('day');
  return tomorrow;
}

// Функция для получения следующих 9 дат, начиная с завтрашнего дня
function getNextNineDates(moment) {
  const dates = [];
  let currentDay = getTomorrow(moment);

  while (dates.length < 9) {
    const isSunday = currentDay.day() === 0; // 0 - это воскресенье

    // Если день не воскресенье, добавляем его в список дат
    if (!isSunday) {
      dates.push({
        date: currentDay.format('DD.MM'), // Форматируем дату в ДД:ММ
        originalDate: currentDay.clone(), // Сохраняем исходное значение даты
      });
    }

    currentDay.add(1, 'day');
  }

  return dates;
}

//Функция задания матрицы 3 на 3 для дат
function createMatrixdate(arr) {
  const matrixdate = [];
  for (let i = 0; i < 3; i++) {
    matrixdate.push(arr.slice(i * 3, i * 3 + 3));
  }
  return matrixdate;
}


  module.exports = {
    sendFileToAdmin,
    CheckUserDB, 
    getTomorrow,
    getNextNineDates,
    createMatrixdate,
  };