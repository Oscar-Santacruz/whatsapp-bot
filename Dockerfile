FROM node:22-alpine

WORKDIR /app

COPY package*.json ./

RUN apk add --no-cache --virtual .build-deps python3 make g++ \
    && npm install --omit=optional \
    && apk del .build-deps

COPY . .

ENV PORT=3001
EXPOSE $PORT

CMD ["npm", "start"]
