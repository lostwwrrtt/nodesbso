FROM node:18-slim

WORKDIR /app

# 安装编译依赖 + 运行时库
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    gcc \
    libffi-dev \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# 安装 Node.js 依赖
COPY package*.json ./
RUN npm install

# 复制应用代码
COPY . .

# 暴露端口
EXPOSE 5000

# 启动应用
CMD ["node", "server.js"]
