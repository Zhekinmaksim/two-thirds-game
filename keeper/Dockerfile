FROM node:20-alpine

WORKDIR /app

COPY package.json package.json
RUN npm install --omit=dev

COPY keeper.js keeper.js

CMD ["npm", "start"]
