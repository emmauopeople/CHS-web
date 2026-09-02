# HSD-HARD-002C: Release 1 documentation baseline

Status: Implemented

## Purpose

This increment closes the repository-owned documentation portion of R1-020. It
adds a complete canonical table catalog, a complete HTTP endpoint catalog and
operator/developer guide, candidate release notes, and automated drift checks.

## Evidence

- The data catalog covers all 45 migration-created tables plus
  `schema_migrations` and records domain, classification, viewer boundary, and
  purpose.
- The API catalog covers all 18 registered Release 1 routes and records method,
  audience, authentication, permission, cache policy, and purpose.
- Tests fail when a migration adds a table or application source adds a route
  without a corresponding catalog and human-guide update.
- Catalog validation rejects duplicate entries, unsupported classification or
  exposure values, missing purposes, unsafe cache claims, and invalid permission
  combinations.
- Candidate notes explicitly separate completed application behavior from cloud,
  governance, and cross-repository desktop gates.

Run the focused gate with:

```bash
pnpm docs:check
```

## Scope boundary

This increment changes no runtime route, schema, clinical behavior, permission,
or synchronization contract. It does not claim production readiness. The final
Release 1 demonstration requires the desktop sync worker, and cloud deployment
requires approved infrastructure, identity, privacy, retention, backup, and
incident controls.
