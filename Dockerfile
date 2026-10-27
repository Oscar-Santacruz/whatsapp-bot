FROM node:22-alpine

WORKDIR /app

COPY package*.json ./

RUN apk add --no-cache --virtual .build-deps python3 make g++ \
    && npm install --omit=optional \
    && apk del .build-deps

COPY . .

ENV PORT=3001
EXPOSE $PORT

# node directo, sin npm de padre: se ahorra el proceso de npm (memoria) y el flag le llega directo a node.
# Las señales (SIGTERM del deploy) las atiende el handler de index.js: como PID 1, node no tiene el handler por defecto.
# El heap por defecto de V8 es la mitad de la RAM del contenedor (~256 MB de 512): ahí se caía con
# "JavaScript heap out of memory". Con 320, V8 suma la generación joven y el límite real queda en ~368 MB:
# más ~70 MB nativos y los buffers de media entra en los 512 MB sin que Render mate el contenedor.
CMD ["node", "--max-old-space-size=320", "index.js"]
