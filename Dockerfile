FROM node:20-bookworm-slim

# Install util-linux (untuk nsenter) dan docker CLI
RUN apt-get update && apt-get install -y \
    util-linux \
    docker.io \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package dan install dependencies
COPY package*.json ./
RUN npm install

# Copy seluruh file aplikasi
COPY . .

# Expose port 80
EXPOSE 80

# Jalankan aplikasi
CMD ["npm", "start"]
