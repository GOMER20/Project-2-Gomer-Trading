/*
 * Gomer Trading bot gateway: binary protocol, version 1.
 *
 * The same bytes travel over the TCP listener and the Unix domain socket.
 * Every message is one of the structs below, preceded by gt_header. All
 * structs are packed and little-endian, so on x86-64 and arm64 a received
 * buffer can be read by casting it; nothing needs parsing.
 *
 *   prices, money   int64_t, in units of 1/10000 of a dollar  (GT_PRICE_SCALE)
 *   quantities      uint32_t, whole shares
 *   times           uint64_t, nanoseconds since the Unix epoch
 *   text            fixed width, ASCII, padded with NUL (not always terminated)
 *
 * A connection's first message must be GT_LOGON. An accepted order is
 * acknowledged by its first GT_EXEC_REPORT; only a refusal gets GT_REJECT.
 * The server implementation is backend/src/gateway/protocol.ts.
 */
#ifndef GOMER_GATEWAY_H
#define GOMER_GATEWAY_H

#include <stdint.h>

#define GT_PROTOCOL_VERSION 1
#define GT_PRICE_SCALE      10000
#define GT_MAX_FRAME        1024

/* Message types (gt_header.type). */
enum {
    GT_LOGON         = 0x01, /* client -> server */
    GT_LOGON_ACK     = 0x02, /* server -> client */
    GT_HEARTBEAT     = 0x03, /* client -> server */
    GT_HEARTBEAT_ACK = 0x04, /* server -> client */
    GT_REJECT        = 0x05, /* server -> client */
    GT_SUBSCRIBE     = 0x10, /* client -> server */
    GT_UNSUBSCRIBE   = 0x11, /* client -> server */
    GT_NEW_ORDER     = 0x20, /* client -> server: NewOrderSingle */
    GT_CANCEL        = 0x21, /* client -> server: OrderCancelRequest */
    GT_STATUS        = 0x22, /* client -> server: OrderStatusRequest */
    GT_EXEC_REPORT   = 0x30, /* server -> client */
    GT_BBO           = 0x40, /* server -> client */
    GT_TRADE         = 0x41, /* server -> client */
    GT_DEPTH         = 0x42  /* server -> client, variable length */
};

/* Codes follow FIX where FIX has one. */
enum { GT_SIDE_BUY = 1, GT_SIDE_SELL = 2 };
enum { GT_ORD_MARKET = 1, GT_ORD_LIMIT = 2, GT_ORD_STOP = 3, GT_ORD_STOP_LIMIT = 4 };
enum { GT_TIF_GTC = 1, GT_TIF_IOC = 3, GT_TIF_FOK = 4 };
enum { GT_CHANNEL_BBO = 1, GT_CHANNEL_TRADES = 2, GT_CHANNEL_DEPTH = 4 }; /* bit mask */

enum { /* gt_exec_report.exec_type */
    GT_EXEC_NEW = 0, GT_EXEC_PARTIAL_FILL = 1, GT_EXEC_FILL = 2, GT_EXEC_CANCELED = 3,
    GT_EXEC_REJECTED = 4, GT_EXEC_TRIGGERED = 5, GT_EXEC_STATUS = 6, GT_EXEC_RESTATED = 7
};
enum { /* gt_exec_report.ord_status */
    GT_ORD_STATUS_NEW = 0, GT_ORD_STATUS_PARTIALLY_FILLED = 1, GT_ORD_STATUS_FILLED = 2,
    GT_ORD_STATUS_CANCELED = 3, GT_ORD_STATUS_REJECTED = 4
};
enum { /* gt_reject.code */
    GT_REJ_NOT_LOGGED_ON = 1, GT_REJ_BAD_CREDENTIALS = 2, GT_REJ_MALFORMED = 3, GT_REJ_UNKNOWN_SYMBOL = 4,
    GT_REJ_THROTTLED = 5, GT_REJ_RISK = 6, GT_REJ_UNKNOWN_ORDER = 7, GT_REJ_TOO_LATE_TO_CANCEL = 8,
    GT_REJ_DUPLICATE_CL_ORD_ID = 9, GT_REJ_BUSY = 10, GT_REJ_SANDBOX_CLOSED = 11, GT_REJ_INTERNAL = 99
};

#pragma pack(push, 1)

/* 8 bytes. Precedes every message. */
typedef struct {
    uint16_t length;  /* whole frame in bytes, this header included */
    uint8_t  type;    /* GT_* message type */
    uint8_t  version; /* GT_PROTOCOL_VERSION */
    uint32_t seq;     /* the sender's own count of frames sent, from 1 */
} gt_header;

/* ---- client -> server ---------------------------------------------------- */

typedef struct {          /* 80 bytes */
    gt_header h;
    char      api_key[64];
    uint32_t  heartbeat_ms; /* reserved; send 0 */
    uint32_t  reserved;
} gt_logon;

typedef struct {          /* 16 bytes */
    gt_header h;
    uint64_t  client_time_ns; /* echoed back unchanged: measure your own round trip */
} gt_heartbeat;

typedef struct {          /* 24 bytes; same layout for GT_UNSUBSCRIBE */
    gt_header h;
    char      symbol[8];
    uint8_t   channels;   /* GT_CHANNEL_* bits */
    uint8_t   pad[7];
} gt_subscribe;

typedef struct {          /* 48 bytes */
    gt_header h;
    uint64_t  cl_ord_id;  /* yours; unique within the account; 0 = none */
    char      symbol[8];
    uint8_t   side;       /* GT_SIDE_* */
    uint8_t   ord_type;   /* GT_ORD_* */
    uint8_t   tif;        /* GT_TIF_*; 0 means GTC */
    uint8_t   pad;
    uint32_t  qty;
    int64_t   price;      /* limit price; 0 for market and stop orders */
    int64_t   stop_price; /* 0 unless a stop or stop-limit order */
} gt_new_order;

typedef struct {          /* 16 bytes; GT_CANCEL and GT_STATUS */
    gt_header h;
    uint64_t  cl_ord_id;  /* the cl_ord_id of the order meant */
} gt_order_ref;

/* ---- server -> client ---------------------------------------------------- */

typedef struct {          /* 72 bytes */
    gt_header h;
    uint8_t   status;     /* 0 = logged on */
    uint8_t   pad[3];
    uint32_t  orders_per_second; /* this key's order throttle */
    uint64_t  session_id;
    char      trader_id[24];
    uint8_t   competition_id[16]; /* the sandbox this key trades in (UUID bytes) */
    int64_t   starting_balance;
} gt_logon_ack;

typedef struct {          /* 24 bytes */
    gt_header h;
    uint64_t  client_time_ns;
    uint64_t  server_time_ns;
} gt_heartbeat_ack;

typedef struct {          /* 72 bytes */
    gt_header h;
    uint32_t  ref_seq;    /* header.seq of the message refused */
    uint8_t   ref_type;   /* its message type */
    uint8_t   pad;
    uint16_t  code;       /* GT_REJ_* */
    uint64_t  cl_ord_id;  /* for a refused order, cancel or status request; else 0 */
    char      text[48];
} gt_reject;

typedef struct {          /* 104 bytes */
    gt_header h;
    uint64_t  cl_ord_id;  /* 0 for orders not sent with a numeric id (bracket exits, liquidations) */
    uint8_t   order_id[16]; /* the exchange's id (UUID bytes) */
    char      symbol[8];
    uint8_t   exec_type;  /* GT_EXEC_*: what this report is about */
    uint8_t   ord_status; /* GT_ORD_STATUS_*: where the order stands now */
    uint8_t   side;
    uint8_t   ord_type;
    uint32_t  order_qty;
    uint32_t  cum_qty;    /* shares done so far */
    uint32_t  leaves_qty; /* shares still working */
    uint32_t  last_qty;   /* shares traded in this step; 0 unless a fill */
    uint32_t  reserved;
    int64_t   last_px;    /* their average price */
    int64_t   avg_px;     /* average price of everything done so far */
    int64_t   commission; /* charged on the order so far */
    int64_t   slippage;   /* avg_px against the arrival price, per share; positive is worse */
    uint64_t  transact_time_ns;
} gt_exec_report;

typedef struct {          /* 48 bytes */
    gt_header h;
    char      symbol[8];
    int64_t   bid;
    int64_t   ask;
    uint32_t  bid_size;
    uint32_t  ask_size;
    uint64_t  ts_ns;
} gt_bbo;

typedef struct {          /* 40 bytes */
    gt_header h;
    char      symbol[8];
    int64_t   price;
    uint32_t  size;
    uint32_t  pad;
    uint64_t  ts_ns;
} gt_trade;

typedef struct {          /* 16 bytes */
    int64_t   price;
    uint32_t  size;
    uint32_t  pad;
} gt_level;

typedef struct {          /* 32 bytes, then (n_bids + n_asks) gt_level: bids best first, then asks best first */
    gt_header h;
    char      symbol[8];
    uint64_t  ts_ns;
    uint8_t   n_bids;
    uint8_t   n_asks;
    uint8_t   pad[6];
    /* gt_level levels[]; */
} gt_depth;

#pragma pack(pop)

/* The layouts are the protocol. If a compiler disagrees with these sizes, do not use it as is. */
_Static_assert(sizeof(gt_header) == 8, "gt_header");
_Static_assert(sizeof(gt_logon) == 80, "gt_logon");
_Static_assert(sizeof(gt_heartbeat) == 16, "gt_heartbeat");
_Static_assert(sizeof(gt_subscribe) == 24, "gt_subscribe");
_Static_assert(sizeof(gt_new_order) == 48, "gt_new_order");
_Static_assert(sizeof(gt_order_ref) == 16, "gt_order_ref");
_Static_assert(sizeof(gt_logon_ack) == 72, "gt_logon_ack");
_Static_assert(sizeof(gt_heartbeat_ack) == 24, "gt_heartbeat_ack");
_Static_assert(sizeof(gt_reject) == 72, "gt_reject");
_Static_assert(sizeof(gt_exec_report) == 104, "gt_exec_report");
_Static_assert(sizeof(gt_bbo) == 48, "gt_bbo");
_Static_assert(sizeof(gt_trade) == 40, "gt_trade");
_Static_assert(sizeof(gt_level) == 16, "gt_level");
_Static_assert(sizeof(gt_depth) == 32, "gt_depth");

#endif /* GOMER_GATEWAY_H */
