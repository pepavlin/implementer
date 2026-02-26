import { ConflictError } from "../errors.js";

export class TaskActiveError extends ConflictError {
    constructor(status: string) {
        super(`Cannot retry task with status: ${status}`);
        this.name = "TaskActiveError";
    }
}

export class TaskCancelError extends ConflictError {
    constructor(status: string) {
        super(`Cannot cancel task with status: ${status}`);
        this.name = "TaskCancelError";
    }
}

export class TaskEditError extends ConflictError {
    constructor(message: string) {
        super(message);
        this.name = "TaskEditError";
    }
}
