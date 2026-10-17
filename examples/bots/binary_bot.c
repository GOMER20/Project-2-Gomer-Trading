/*
 * A complete bot for the low-latency gateway, in C.
 *
 * Connects over the Unix domain socket (the fastest way in for a program on
 * the exchange's own machine) or over TCP, logs on, watches the best bid and
 * offer, buys 10 shares at the market, and prints the execution report.
 *
 *   cc -O2 -I ../../docs/gateway -o binary_bot binary_bot.c
 *   GOMER_API_KEY=gtk_... ./binary_bot /tmp/gomer-gateway.sock AAPL      (Unix socket)
 *   GOMER_API_KEY=gtk_... ./binary_bot 127.0.0.1:4010 AAPL               (TCP)
 */
#include <arpa/inet.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <time.h>
#include <unistd.h>

#include "gomer_gateway.h"

static uint32_t seq = 0;

static uint64_t now_ns(void) {
    struct timespec t;
    clock_gettime(CLOCK_MONOTONIC, &t);
    return (uint64_t)t.tv_sec * 1000000000ull + (uint64_t)t.tv_nsec;
}

static gt_header header(uint8_t type, uint16_t length) {
    gt_header h = { length, type, GT_PROTOCOL_VERSION, ++seq };
    return h;
}

static void send_all(int fd, const void *data, size_t length) {
    const char *p = data;
    while (length > 0) {
        ssize_t n = write(fd, p, length);
        if (n <= 0) { perror("write"); exit(1); }
        p += n;
        length -= (size_t)n;
    }
}

/* Reads exactly one frame into `frame` and returns its type. */
static uint8_t read_frame(int fd, uint8_t *frame) {
    size_t have = 0, want = sizeof(gt_header);
    while (have < want) {
        ssize_t n = read(fd, frame + have, want - have);
        if (n <= 0) { fprintf(stderr, "the gateway closed the connection\n"); exit(1); }
        have += (size_t)n;
        if (have == sizeof(gt_header)) want = ((gt_header *)frame)->length;
    }
    return ((gt_header *)frame)->type;
}

static int connect_to(const char *where) {
    const char *colon = strrchr(where, ':');
    if (where[0] == '/' || !colon) { /* a path: Unix domain socket */
        int fd = socket(AF_UNIX, SOCK_STREAM, 0);
        struct sockaddr_un address = { .sun_family = AF_UNIX };
        strncpy(address.sun_path, where, sizeof(address.sun_path) - 1);
        if (connect(fd, (struct sockaddr *)&address, sizeof(address)) != 0) { perror("connect"); exit(1); }
        return fd;
    }
    char host[64] = { 0 };
    memcpy(host, where, (size_t)(colon - where) < sizeof(host) - 1 ? (size_t)(colon - where) : sizeof(host) - 1);
    int fd = socket(AF_INET, SOCK_STREAM, 0);
    int one = 1;
    setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof(one)); /* send each order now, not when a packet fills */
    struct sockaddr_in address = { .sin_family = AF_INET, .sin_port = htons((uint16_t)atoi(colon + 1)) };
    inet_pton(AF_INET, host, &address.sin_addr);
    if (connect(fd, (struct sockaddr *)&address, sizeof(address)) != 0) { perror("connect"); exit(1); }
    return fd;
}

int main(int argc, char **argv) {
    const char *key = getenv("GOMER_API_KEY");
    if (argc < 3 || !key) { fprintf(stderr, "usage: GOMER_API_KEY=gtk_... %s <socket path | host:port> <SYMBOL>\n", argv[0]); return 2; }
    const char *symbol = argv[2];
    int fd = connect_to(argv[1]);
    uint8_t frame[GT_MAX_FRAME];

    gt_logon logon = { .h = header(GT_LOGON, sizeof(gt_logon)) };
    strncpy(logon.api_key, key, sizeof(logon.api_key));
    send_all(fd, &logon, sizeof(logon));
    if (read_frame(fd, frame) != GT_LOGON_ACK) {
        fprintf(stderr, "logon refused: %.48s\n", ((gt_reject *)frame)->text);
        return 1;
    }
    gt_logon_ack *ack = (gt_logon_ack *)frame;
    printf("logged on as %.24s, starting balance $%.2f, %u orders a second\n", ack->trader_id, (double)ack->starting_balance / GT_PRICE_SCALE, ack->orders_per_second);

    gt_subscribe subscribe = { .h = header(GT_SUBSCRIBE, sizeof(gt_subscribe)), .channels = GT_CHANNEL_BBO };
    strncpy(subscribe.symbol, symbol, sizeof(subscribe.symbol));
    send_all(fd, &subscribe, sizeof(subscribe));
    while (read_frame(fd, frame) != GT_BBO) { }
    gt_bbo *bbo = (gt_bbo *)frame; /* no parsing: the bytes are the struct */
    printf("%.8s  bid %.2f x %u   ask %.2f x %u\n", bbo->symbol, (double)bbo->bid / GT_PRICE_SCALE, bbo->bid_size, (double)bbo->ask / GT_PRICE_SCALE, bbo->ask_size);

    gt_new_order order = { .h = header(GT_NEW_ORDER, sizeof(gt_new_order)), .cl_ord_id = now_ns(), .side = GT_SIDE_BUY, .ord_type = GT_ORD_MARKET, .tif = GT_TIF_IOC, .qty = 10 };
    strncpy(order.symbol, symbol, sizeof(order.symbol));
    uint64_t sent = now_ns();
    send_all(fd, &order, sizeof(order));

    for (;;) {
        uint8_t type = read_frame(fd, frame);
        if (type == GT_REJECT && ((gt_reject *)frame)->cl_ord_id == order.cl_ord_id) {
            printf("order refused (code %u): %.48s\n", ((gt_reject *)frame)->code, ((gt_reject *)frame)->text);
            return 1;
        }
        if (type != GT_EXEC_REPORT) continue; /* market data keeps arriving in between */
        gt_exec_report *report = (gt_exec_report *)frame;
        if (report->cl_ord_id != order.cl_ord_id) continue;
        printf("execution report after %.0f microseconds: bought %u of %u %.8s at %.4f, slippage %.4f a share, status %u\n",
               (double)(now_ns() - sent) / 1000.0, report->cum_qty, report->order_qty, report->symbol,
               (double)report->avg_px / GT_PRICE_SCALE, (double)report->slippage / GT_PRICE_SCALE, report->ord_status);
        if (report->ord_status == GT_ORD_STATUS_FILLED || report->ord_status == GT_ORD_STATUS_CANCELED) break;
    }
    close(fd);
    return 0;
}
