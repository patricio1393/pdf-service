FROM node:20-alpine

# Instalar Tesseract OCR (con idioma inglés para leer dígitos) para la lectura de DNI
RUN apk add --no-cache tesseract-ocr tesseract-ocr-data-eng

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./

EXPOSE 3000

CMD ["node", "server.js"]
