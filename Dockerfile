FROM node:20-alpine

WORKDIR /app

COPY package*.json ./

# --omit=optional skips sharp and other optional native deps (not needed for text-only WhatsApp messages)
RUN npm install --omit=optional

COPY . .

ENV PORT=3001
EXPOSE $PORT

CMD ["npm", "start"]
