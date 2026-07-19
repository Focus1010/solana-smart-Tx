# Grant Context

This package is part of a Solana Foundation grant application submitted
through Superteam Nigeria.

---

## What the grant funds

The core `send()` function and rule-based adapter are already built and
working. The grant funds the remaining work needed to make this useful for
every Nigerian builder:

- AI adapter (Groq and Anthropic) for intelligent tip and retry decisions
- Open-source remittance bot - a working Telegram bot for sending USDC
- Open-source P2P payment request bot - send a payment link, get notified on receipt
- Yellowstone gRPC slot streaming for faster lifecycle tracking
- NPM publish and official versioning so any builder can install with one command

---

## Underlying infrastructure

This package is built on a production-grade Solana transaction stack
developed for the Superteam Nigeria Advanced Infrastructure Challenge:

[github.com/Focus1010/solana-smart-tx-stack](https://github.com/Focus1010/solana-smart-tx-stack)

That repository contains:
- 23 mainnet-beta transaction runs with a 96% landing rate
- 98ms median processed-to-confirmed latency
- 15-type failure classifier with confidence scores and recovery paths
- Jito bundle submission with leader-window gating
- Yellowstone gRPC slot streaming with RPC polling fallback
- AI-driven tip and retry decisions using Groq LLaMA 3.3 70B
- Full lifecycle logs, fault injection evidence, and a verification report

---

## The problem this solves for Nigerian builders

Nigeria moved approximately $59 billion in crypto volume between July 2023
and June 2024. Most of that is stablecoin transfers solving real problems:
naira depreciation, remittance fees that run 9% through traditional rails,
and restricted access to foreign exchange.

The builders shipping these payment tools on Telegram have no access to the
reliability infrastructure that makes transactions actually land. Premium
RPC access, Jito bundle submission, and Yellowstone streaming are priced
for funded teams, not bootstrapped Nigerian developers.

This package makes that infrastructure free and open. The default
rule-based mode runs entirely on free tiers. A Nigerian builder can go
from zero to a working USDC payment bot in one afternoon.

---

## Target users

Primary: Nigerian Solana builders shipping stablecoin payment bots,
remittance tools, and P2P payment apps on Telegram and the web.

Secondary: Any Solana developer who needs reliable transaction submission
without building and maintaining their own retry and lifecycle stack.
