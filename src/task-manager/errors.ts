import { ConflictError } from "../errors.js";

export class TaskActiveError extends ConflictError {
    constructor(status: string) {
        super(`Cannot retry task with status: ${status}`);
        this.name = "TaskActiveError";
    }
}
