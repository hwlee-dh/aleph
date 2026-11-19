/** API가 돌려준 오류. message는 화면에 그대로 보여도 되는 말이다. */
export class ApiError extends Error {
  status: number;
  /** 서버가 오류와 함께 준 본문 (예: 되돌리기 409의 `touched_later`). */
  data: unknown;
  constructor(status: number, message: string, data: unknown = null) {
    super(message);
    this.status = status;
    this.data = data;
  }
}
