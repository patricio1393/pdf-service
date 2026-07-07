FROM node:20-alpine

# Instalar Tesseract OCR (con idioma español) para la lectura de DNI
RUN apk add --no-cache tesseract-ocr tesseract-ocr-data-spa

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./

EXPOSE 3000

CMD ["node", "server.js"]
