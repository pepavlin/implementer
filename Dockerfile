FROM node:22

# Docker CLI for creating sandbox containers (talks to host daemon via mounted socket)
COPY --from=docker:27-cli /usr/local/bin/docker /usr/local/bin/docker

# Trust all directories for git (workspace files are chowned to sandbox user uid)
RUN git config --global --add safe.directory '*'

# Git credential helper that reads GITHUB_TOKEN env var at runtime
RUN printf '#!/bin/sh\necho username=x-access-token\necho "password=$GITHUB_TOKEN"\n' \
      > /usr/local/bin/git-credential-env && \
    chmod +x /usr/local/bin/git-credential-env && \
    git config --global credential.helper /usr/local/bin/git-credential-env

WORKDIR /app

COPY package*.json ./
RUN npm install
COPY . .

EXPOSE 3000
CMD ["npx", "tsx", "src/index.ts"]
