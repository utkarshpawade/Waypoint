export type CabinClass = 'ECONOMY' | 'PREMIUM_ECONOMY' | 'BUSINESS' | 'FIRST';
export type Preference = 'CHEAPEST' | 'FASTEST' | 'BEST_VALUE' | 'COMFORT';
export type TripType = 'ONE_WAY' | 'ROUND_TRIP';

export interface SearchQuery {
  origin: string; // IATA
  destination: string; // IATA
  departDate: string; // yyyy-mm-dd
  returnDate?: string; // yyyy-mm-dd
  adults: number;
  children?: number;
  infants?: number;
  cabin: CabinClass;
  currency: 'INR';
  nonStopOnly?: boolean;
  maxPrice?: number;
  departWindow?: { earliest?: string; latest?: string }; // HH:mm local
}

export interface Segment {
  carrierCode: string;
  carrierName: string;
  flightNumber: string; // e.g. "6E-1471"
  from: string;
  to: string;
  departISO: string; // local ISO with offset
  arriveISO: string;
  durationMin: number;
  aircraft?: string;
}

export interface Itin {
  segments: Segment[];
  totalDurationMin: number;
  stops: number;
  /** Minutes on the ground between segments, in order. */
  layoverMin: number[];
}

export interface FlightOffer {
  id: string;
  outbound: Itin;
  inbound?: Itin;
  price: { total: number; perAdult: number; currency: 'INR' };
  cabin: CabinClass;
  seatsRemaining?: number;
  refundable: boolean;
  baggage: { cabinKg: number; checkInKg: number };
  provider: 'mock' | 'amadeus';
}

export interface FlightProvider {
  name: string;
  search(q: SearchQuery): Promise<FlightOffer[]>;
}

export type PickLabel = 'CHEAPEST' | 'FASTEST' | 'BEST_VALUE';

export interface RankedPick {
  label: PickLabel;
  offer: FlightOffer;
  score: number;
  whyThisOne: string;
}
