import type { Request, Response, NextFunction, RequestHandler } from "express";

export class HttpError extends Error {
    constructor(
        public readonly statusCode: number,
        message: string,
        public readonly details?: unknown
    ) {
        super(message);
        this.name = this.constructor.name;
    }
}

export class BadRequestError extends HttpError {
    constructor(message = "Bad Request", details?: unknown) {
        super(400, message, details);
    }
}

export class UnauthorizedError extends HttpError {
    constructor(message = "Unauthorized") {
        super(401, message);
    }
}

export class ForbiddenError extends HttpError {
    constructor(message = "Forbidden") {
        super(403, message);
    }
}

export class NotFoundError extends HttpError {
    constructor(message = "Not Found") {
        super(404, message);
    }
}

export class ConflictError extends HttpError {
    constructor(message = "Conflict") {
        super(409, message);
    }
}

export class TooManyRequestsError extends HttpError {
    constructor(message = "Too Many Requests") {
        super(429, message);
    }
}

/**
 * Wraps an async Express route handler so that any thrown error is forwarded
 * to Express error middleware via next(). Required in Express 4 since unhandled
 * promise rejections don't reach error middleware automatically.
 *
 * Route params are typed as Record<string, string> because Express route
 * params are always strings at runtime, regardless of type definition version.
 */
export function asyncRoute(
    fn: (
        req: Omit<Request, "params"> & { params: Record<string, string> },
        res: Response,
        next: NextFunction
    ) => Promise<void>
): RequestHandler {
    return (req, res, next) => {
        fn(req as unknown as Omit<Request, "params"> & { params: Record<string, string> }, res, next).catch(next);
    };
}
