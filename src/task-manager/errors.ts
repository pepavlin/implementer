export class TaskActiveError extends Error {
    constructor(status: string) {
        super(`Cannot retry task with status: ${status}`);
        this.name = "TaskActiveError";
    }
}

export class TaskCancelError extends Error {
    constructor(status: string) {
        super(`Cannot cancel task with status: ${status}`);
        this.name = "TaskCancelError";
    }
}

export class TaskEditError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "TaskEditError";
    }
}
