/*
 * Small streaming SHA-256 core for the Sakutto model downloader.
 *
 * This is an original implementation of FIPS 180-4 SHA-256. It uses no libc and
 * exports one context, one 64 KiB input scratch buffer, a pointer getter, and three
 * hashing entry points: sha256_init, sha256_update, and sha256_final. JavaScript creates
 * one WebAssembly instance per hasher, so concurrent downloads never share state.
 *
 * Copyright (c) 2026 Sakutto contributors
 * SPDX-License-Identifier: MIT
 *
 * Rebuild (the base64 payload in sha256-wasm.ts is generated from the .wasm):
 *   clang --target=wasm32 -O3 -nostdlib -fvisibility=hidden -Wl,--no-entry \
 *     -Wl,--export=sha256_init -Wl,--export=sha256_update -Wl,--export=sha256_final \
 *     -Wl,--export=sha256_input -Wl,--export-memory \
 *     -Wl,--initial-memory=262144 -Wl,--max-memory=262144 \
 *     -o sha256.wasm sha256.wasm.c
 *   base64 -w0 sha256.wasm
 */

#include <stdint.h>

#define EXPORT __attribute__((visibility("default")))

typedef struct {
  uint32_t state[8];
  uint64_t length;
  uint8_t buffer[64];
  uint32_t fill;
} sha256_context;

static sha256_context ctx;
static uint8_t input[65536];

static const uint32_t K[64] = {
  0x428a2f98u, 0x71374491u, 0xb5c0fbcfu, 0xe9b5dba5u,
  0x3956c25bu, 0x59f111f1u, 0x923f82a4u, 0xab1c5ed5u,
  0xd807aa98u, 0x12835b01u, 0x243185beu, 0x550c7dc3u,
  0x72be5d74u, 0x80deb1feu, 0x9bdc06a7u, 0xc19bf174u,
  0xe49b69c1u, 0xefbe4786u, 0x0fc19dc6u, 0x240ca1ccu,
  0x2de92c6fu, 0x4a7484aau, 0x5cb0a9dcu, 0x76f988dau,
  0x983e5152u, 0xa831c66du, 0xb00327c8u, 0xbf597fc7u,
  0xc6e00bf3u, 0xd5a79147u, 0x06ca6351u, 0x14292967u,
  0x27b70a85u, 0x2e1b2138u, 0x4d2c6dfcu, 0x53380d13u,
  0x650a7354u, 0x766a0abbu, 0x81c2c92eu, 0x92722c85u,
  0xa2bfe8a1u, 0xa81a664bu, 0xc24b8b70u, 0xc76c51a3u,
  0xd192e819u, 0xd6990624u, 0xf40e3585u, 0x106aa070u,
  0x19a4c116u, 0x1e376c08u, 0x2748774cu, 0x34b0bcb5u,
  0x391c0cb3u, 0x4ed8aa4au, 0x5b9cca4fu, 0x682e6ff3u,
  0x748f82eeu, 0x78a5636fu, 0x84c87814u, 0x8cc70208u,
  0x90befffau, 0xa4506cebu, 0xbef9a3f7u, 0xc67178f2u,
};

static inline uint32_t rotr(uint32_t value, uint32_t bits) {
  return (value >> bits) | (value << (32u - bits));
}

static void compress(const uint8_t *block) {
  uint32_t w[64];
  uint32_t a;
  uint32_t b;
  uint32_t c;
  uint32_t d;
  uint32_t e;
  uint32_t f;
  uint32_t g;
  uint32_t h;
  uint32_t i;

  for (i = 0; i < 16u; i += 1u) {
    const uint8_t *p = block + i * 4u;
    w[i] = ((uint32_t)p[0] << 24) | ((uint32_t)p[1] << 16) | ((uint32_t)p[2] << 8) | (uint32_t)p[3];
  }
  for (i = 16u; i < 64u; i += 1u) {
    const uint32_t s0 = rotr(w[i - 15u], 7u) ^ rotr(w[i - 15u], 18u) ^ (w[i - 15u] >> 3u);
    const uint32_t s1 = rotr(w[i - 2u], 17u) ^ rotr(w[i - 2u], 19u) ^ (w[i - 2u] >> 10u);
    w[i] = w[i - 16u] + s0 + w[i - 7u] + s1;
  }

  a = ctx.state[0];
  b = ctx.state[1];
  c = ctx.state[2];
  d = ctx.state[3];
  e = ctx.state[4];
  f = ctx.state[5];
  g = ctx.state[6];
  h = ctx.state[7];

  for (i = 0; i < 64u; i += 1u) {
    const uint32_t sum1 = rotr(e, 6u) ^ rotr(e, 11u) ^ rotr(e, 25u);
    const uint32_t choose = (e & f) ^ (~e & g);
    const uint32_t temp1 = h + sum1 + choose + K[i] + w[i];
    const uint32_t sum0 = rotr(a, 2u) ^ rotr(a, 13u) ^ rotr(a, 22u);
    const uint32_t majority = (a & b) ^ (a & c) ^ (b & c);
    const uint32_t temp2 = sum0 + majority;

    h = g;
    g = f;
    f = e;
    e = d + temp1;
    d = c;
    c = b;
    b = a;
    a = temp1 + temp2;
  }

  ctx.state[0] += a;
  ctx.state[1] += b;
  ctx.state[2] += c;
  ctx.state[3] += d;
  ctx.state[4] += e;
  ctx.state[5] += f;
  ctx.state[6] += g;
  ctx.state[7] += h;
}

EXPORT uint32_t sha256_input(void) {
  return (uint32_t)(uintptr_t)input;
}

EXPORT void sha256_init(void) {
  ctx.state[0] = 0x6a09e667u;
  ctx.state[1] = 0xbb67ae85u;
  ctx.state[2] = 0x3c6ef372u;
  ctx.state[3] = 0xa54ff53au;
  ctx.state[4] = 0x510e527fu;
  ctx.state[5] = 0x9b05688cu;
  ctx.state[6] = 0x1f83d9abu;
  ctx.state[7] = 0x5be0cd19u;
  ctx.length = 0u;
  ctx.fill = 0u;
}

EXPORT void sha256_update(uint32_t length) {
  const uint8_t *data = input;
  ctx.length += length;

  if (ctx.fill > 0u) {
    uint32_t take = 64u - ctx.fill;
    uint32_t index;
    if (take > length) take = length;
    for (index = 0u; index < take; index += 1u) ctx.buffer[ctx.fill + index] = data[index];
    ctx.fill += take;
    data += take;
    length -= take;
    if (ctx.fill == 64u) {
      compress(ctx.buffer);
      ctx.fill = 0u;
    }
  }

  while (length >= 64u) {
    compress(data);
    data += 64u;
    length -= 64u;
  }

  if (length > 0u) {
    uint32_t index;
    for (index = 0u; index < length; index += 1u) ctx.buffer[ctx.fill + index] = data[index];
    ctx.fill += length;
  }
}

EXPORT void sha256_final(uint32_t output) {
  uint8_t *out = (uint8_t *)(uintptr_t)output;
  const uint64_t bits = ctx.length * 8u;
  uint32_t index;

  ctx.buffer[ctx.fill] = 0x80u;
  ctx.fill += 1u;
  if (ctx.fill > 56u) {
    while (ctx.fill < 64u) ctx.buffer[ctx.fill++] = 0u;
    compress(ctx.buffer);
    ctx.fill = 0u;
  }
  while (ctx.fill < 56u) ctx.buffer[ctx.fill++] = 0u;

  for (index = 0u; index < 8u; index += 1u) {
    ctx.buffer[56u + index] = (uint8_t)(bits >> (56u - index * 8u));
  }
  compress(ctx.buffer);

  for (index = 0u; index < 8u; index += 1u) {
    out[index * 4u] = (uint8_t)(ctx.state[index] >> 24u);
    out[index * 4u + 1u] = (uint8_t)(ctx.state[index] >> 16u);
    out[index * 4u + 2u] = (uint8_t)(ctx.state[index] >> 8u);
    out[index * 4u + 3u] = (uint8_t)ctx.state[index];
  }
}
