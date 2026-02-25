FROM node:18-alpine

# Baileys requires some additional system libraries for its image processing (sharp)
RUN apk add --no-cache \
    vips-dev \
    build-base \
    python3

WORKDIR /app

COPY package*.json ./

RUN npm install

COPY . .

# Render exposes the PORT environment variable
ENV PORT=3000
EXPOSE $PORT

CMD ["npm", "start"]
