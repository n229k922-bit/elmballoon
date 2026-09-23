-- Test-order workflow only. Do not use this table as a contact, address, or payment store.
CREATE TABLE IF NOT EXISTS order_cards (
  id TEXT PRIMARY KEY,
  order_thread_id TEXT NOT NULL UNIQUE REFERENCES customer_order_threads(id),
  status TEXT NOT NULL CHECK (status IN (
    'intake', 'needs_details', 'owner_review', 'proposing',
    'awaiting_customer_confirmation', 'production_confirmed',
    'production_in_progress', 'ready_for_review', 'ready_for_fulfillment',
    'fulfilled', 'closed', 'cancelled'
  )) DEFAULT 'intake',
  purpose TEXT,
  recipient_profile TEXT,
  product_reference TEXT,
  requested_quantity INTEGER,
  budget_yen INTEGER,
  color_preference TEXT,
  size_preference TEXT,
  character_request TEXT,
  balloon_message TEXT,
  card_message TEXT,
  fulfillment_type TEXT NOT NULL CHECK (fulfillment_type IN ('pickup', 'delivery', 'visit', 'shipping', 'unknown')) DEFAULT 'unknown',
  requested_date TEXT,
  requested_time TEXT,
  proposal_status TEXT NOT NULL CHECK (proposal_status IN ('not_requested', 'owner_preparing', 'sent', 'accepted', 'declined')) DEFAULT 'not_requested',
  completion_photo_status TEXT NOT NULL CHECK (completion_photo_status IN ('not_requested', 'owner_review', 'approved_to_send', 'sent')) DEFAULT 'not_requested',
  fulfillment_status TEXT NOT NULL CHECK (fulfillment_status IN ('not_scheduled', 'scheduled', 'in_progress', 'delivered_or_picked_up', 'cancelled')) DEFAULT 'not_scheduled',
  owner_notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS order_cards_status_idx
  ON order_cards(status, requested_date ASC);

CREATE TABLE IF NOT EXISTS order_card_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_card_id TEXT NOT NULL REFERENCES order_cards(id),
  event_type TEXT NOT NULL,
  actor TEXT NOT NULL CHECK (actor IN ('customer', 'assistant', 'owner', 'system')),
  detail TEXT,
  occurred_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS order_card_events_card_idx
  ON order_card_events(order_card_id, occurred_at ASC);
