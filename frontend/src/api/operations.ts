import { API_BASE_URL } from "../constants/app";
import type {
  Booking,
  BookingResult,
  Member,
  PriceQuote,
  Room,
  ApiErrorBody,
} from "../types/operations";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    ...init,
  });

  if (!response.ok) {
    let body: ApiErrorBody | null = null;
    try {
      body = (await response.json()) as ApiErrorBody;
    } catch {
      body = null;
    }
    throw new ApiError(
      response.status,
      body?.error ?? "REQUEST_FAILED",
      body?.message ?? `请求失败（HTTP ${response.status}）`,
    );
  }

  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

export const operationsApi = {
  listRooms: () => request<Room[]>("/rooms"),
  setMaintenance: (id: string, underMaintenance: boolean) =>
    request<Room>(`/rooms/${id}/maintenance`, {
      method: "PATCH",
      body: JSON.stringify({ underMaintenance }),
    }),

  listMembers: () => request<Member[]>("/members"),
  recharge: (id: string, amount: number) =>
    request<Member>(`/members/${id}/recharge`, {
      method: "POST",
      body: JSON.stringify({ amount }),
    }),

  listBookings: (includeCancelled = false) =>
    request<Booking[]>(`/bookings${includeCancelled ? "?all=true" : ""}`),
  quote: (input: { roomId: string; memberId: string; startTime: string; endTime: string }) =>
    request<PriceQuote>("/bookings/quote", { method: "POST", body: JSON.stringify(input) }),
  createBooking: (input: {
    roomId: string;
    memberId: string;
    startTime: string;
    endTime: string;
  }) =>
    request<BookingResult>("/bookings", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  cancelBooking: (id: string) =>
    request<BookingResult>(`/bookings/${id}/cancel`, { method: "POST" }),
};
