import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const locales = {
  es: {
    pdfFileAccessBody:
      'Sakutto no puede leer este PDF desde la página. Abra chrome://extensions, elija Sakutto y active «Permitir acceso a URL de archivos». También puede elegir el PDF abajo y abrirlo en este lector.',
    imageFileAccessHeading: 'Traducir una imagen local',
    imageFileAccessBody:
      'Sakutto no puede leer esta imagen desde la página. Abra chrome://extensions, elija Sakutto y active «Permitir acceso a URL de archivos». También puede elegir la imagen abajo y traducirla en este dispositivo.',
    imageFileAccessChoose: 'Elegir archivo de imagen',
  },
  fr: {
    pdfFileAccessBody:
      'Sakutto ne peut pas lire ce PDF depuis la page. Ouvrez chrome://extensions, choisissez Sakutto et activez « Autoriser l’accès aux URL de fichiers ». Vous pouvez aussi choisir le PDF ci-dessous et l’ouvrir dans ce lecteur.',
    imageFileAccessHeading: 'Traduire une image locale',
    imageFileAccessBody:
      'Sakutto ne peut pas lire cette image depuis la page. Ouvrez chrome://extensions, choisissez Sakutto et activez « Autoriser l’accès aux URL de fichiers ». Vous pouvez aussi choisir l’image ci-dessous et la traduire sur cet appareil.',
    imageFileAccessChoose: 'Choisir un fichier image',
  },
  id: {
    pdfFileAccessBody:
      'Sakutto tidak dapat membaca PDF ini dari halaman. Buka chrome://extensions, pilih Sakutto, dan aktifkan “Allow access to file URLs”. Anda juga dapat memilih PDF di bawah dan membukanya di pembaca ini.',
    imageFileAccessHeading: 'Terjemahkan gambar lokal',
    imageFileAccessBody:
      'Sakutto tidak dapat membaca gambar ini dari halaman. Buka chrome://extensions, pilih Sakutto, dan aktifkan “Allow access to file URLs”. Anda juga dapat memilih file gambar di bawah dan menerjemahkannya di perangkat ini.',
    imageFileAccessChoose: 'Pilih file gambar',
  },
  it: {
    pdfFileAccessBody:
      'Sakutto non può leggere questo PDF dalla pagina. Apri chrome://extensions, scegli Sakutto e attiva “Consenti accesso agli URL dei file”. Puoi anche scegliere il PDF qui sotto e aprirlo in questo lettore.',
    imageFileAccessHeading: 'Traduci un’immagine locale',
    imageFileAccessBody:
      'Sakutto non può leggere questa immagine dalla pagina. Apri chrome://extensions, scegli Sakutto e attiva “Consenti accesso agli URL dei file”. Puoi anche scegliere il file immagine qui sotto e tradurlo su questo dispositivo.',
    imageFileAccessChoose: 'Scegli file immagine',
  },
  ko: {
    pdfFileAccessBody:
      'Sakutto가 페이지에서 이 PDF를 읽을 수 없습니다. chrome://extensions에서 Sakutto를 선택하고 “파일 URL에 대한 액세스 허용”(Allow access to file URLs)을 켜세요. 아래에서 PDF를 선택해 이 리더에서 열 수도 있습니다.',
    imageFileAccessHeading: '로컬 이미지 번역',
    imageFileAccessBody:
      'Sakutto가 페이지에서 이 이미지를 읽을 수 없습니다. chrome://extensions에서 Sakutto를 선택하고 “파일 URL에 대한 액세스 허용”(Allow access to file URLs)을 켜세요. 아래에서 이미지 파일을 선택해 이 기기에서 번역할 수도 있습니다.',
    imageFileAccessChoose: '이미지 파일 선택',
  },
  pt_BR: {
    pdfFileAccessBody:
      'O Sakutto não consegue ler este PDF a partir da página. Abra chrome://extensions, escolha o Sakutto e ative “Permitir acesso a URLs de arquivo”. Você também pode escolher o PDF abaixo e abri-lo neste leitor.',
    imageFileAccessHeading: 'Traduzir uma imagem local',
    imageFileAccessBody:
      'O Sakutto não consegue ler esta imagem a partir da página. Abra chrome://extensions, escolha o Sakutto e ative “Permitir acesso a URLs de arquivo”. Você também pode escolher o arquivo de imagem abaixo e traduzi-lo neste dispositivo.',
    imageFileAccessChoose: 'Escolher arquivo de imagem',
  },
  ru: {
    pdfFileAccessBody:
      'Sakutto не может прочитать этот PDF со страницы. Откройте chrome://extensions, выберите Sakutto и включите «Разрешить доступ к URL файлов». Вы также можете выбрать PDF ниже и открыть его в этом ридере.',
    imageFileAccessHeading: 'Перевести локальное изображение',
    imageFileAccessBody:
      'Sakutto не может прочитать это изображение со страницы. Откройте chrome://extensions, выберите Sakutto и включите «Разрешить доступ к URL файлов». Вы также можете выбрать файл изображения ниже и перевести его на этом устройстве.',
    imageFileAccessChoose: 'Выбрать файл изображения',
  },
  th: {
    pdfFileAccessBody:
      'Sakutto อ่าน PDF นี้จากหน้าเว็บไม่ได้ เปิด chrome://extensions เลือก Sakutto แล้วเปิด “Allow access to file URLs” หรือเลือก PDF ด้านล่างเพื่อเปิดในโปรแกรมอ่านนี้',
    imageFileAccessHeading: 'แปลรูปภาพในเครื่อง',
    imageFileAccessBody:
      'Sakutto อ่านรูปภาพนี้จากหน้าเว็บไม่ได้ เปิด chrome://extensions เลือก Sakutto แล้วเปิด “Allow access to file URLs” หรือเลือกไฟล์รูปด้านล่างเพื่อแปลบนอุปกรณ์นี้',
    imageFileAccessChoose: 'เลือกไฟล์รูปภาพ',
  },
  vi: {
    pdfFileAccessBody:
      'Sakutto không đọc được PDF này từ trang. Mở chrome://extensions, chọn Sakutto và bật “Allow access to file URLs”. Bạn cũng có thể chọn PDF bên dưới và mở trong trình đọc này.',
    imageFileAccessHeading: 'Dịch ảnh cục bộ',
    imageFileAccessBody:
      'Sakutto không đọc được ảnh này từ trang. Mở chrome://extensions, chọn Sakutto và bật “Allow access to file URLs”. Bạn cũng có thể chọn tệp ảnh bên dưới và dịch trên thiết bị này.',
    imageFileAccessChoose: 'Chọn tệp ảnh',
  },
  zh_CN: {
    pdfFileAccessBody:
      'Sakutto 无法从页面读取此 PDF。请打开 chrome://extensions，选择 Sakutto 并开启“允许访问文件网址”（Allow access to file URLs）。也可以在下方选择 PDF 并在此阅读器中打开。',
    imageFileAccessHeading: '翻译本地图片',
    imageFileAccessBody:
      'Sakutto 无法从页面读取此图片。请打开 chrome://extensions，选择 Sakutto 并开启“允许访问文件网址”（Allow access to file URLs）。也可以在下方选择图片文件并在此设备上翻译。',
    imageFileAccessChoose: '选择图片文件',
  },
  zh_TW: {
    pdfFileAccessBody:
      'Sakutto 無法從頁面讀取此 PDF。請開啟 chrome://extensions，選擇 Sakutto 並開啟「允許存取檔案網址」（Allow access to file URLs）。也可以在下方選擇 PDF 並在此閱讀器中開啟。',
    imageFileAccessHeading: '翻譯本機圖片',
    imageFileAccessBody:
      'Sakutto 無法從頁面讀取此圖片。請開啟 chrome://extensions，選擇 Sakutto 並開啟「允許存取檔案網址」（Allow access to file URLs）。也可以在下方選擇圖片檔並在此裝置上翻譯。',
    imageFileAccessChoose: '選擇圖片檔',
  },
};

for (const [locale, strings] of Object.entries(locales)) {
  const path = join(root, 'public/_locales', locale, 'messages.json');
  const data = JSON.parse(readFileSync(path, 'utf8'));
  data.pdfFileAccessBody = {
    message: strings.pdfFileAccessBody,
    description: 'Guidance when a local PDF cannot be read from a file:// tab.',
  };
  for (const key of ['imageFileAccessHeading', 'imageFileAccessBody', 'imageFileAccessChoose']) {
    data[key].message = strings[key];
  }
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
}
