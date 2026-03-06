FROM node:22

# Docker CLI for creating sandbox containers (talks to host daemon via mounted socket)
COPY --from=docker:27-cli /usr/local/bin/docker /usr/local/bin/docker

# GitHub CLI for creating pull requests after task completion
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /usr/share/keyrings/githubcli-archive-keyring.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list && \
    apt-get update && apt-get install -y gh && \
    rm -rf /var/lib/apt/lists/*

# Trust all directories for git (workspace files are chowned to sandbox user uid)
RUN git config --global --add safe.directory '*' && \
    git config --global user.name "Implementer" && \
    git config --global user.email "implementer@noreply"

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
