# HSW-019F combined acceptance and rollout

Status: automated software acceptance implemented; physical two-PC installation and field sign-off remain pending. Automated fixtures do not substitute for the Windows/laptop steps below.

## Automated evidence

| Capability | Executable evidence |
| --- | --- |
| Offline persistence, restart, pending work and local cache | Desktop `pnpm verify`; central-history service tests close/reopen SQLite during interrupted retrieval and preserve offline snapshots |
| Two installations, same canonical identity and separate source ownership | API `provider-fhir-pilot.integration.test.ts`; two installations in one organization and a third outside it |
| All synchronized history domains, late changes, voids and cursor replay | API `patient-history.integration.test.ts`; desktop central-history integration tests |
| Duplicate-free exact batch replay | Pilot integration plus the existing synchronization recovery drill |
| Identity review and delivery | Existing identity-review/resolution-delivery PostgreSQL and browser suites |
| Hospital request/approval, scoped grants, patient permission and credential revocation | Pilot provider integration and `provider-access.pw.ts` |
| FHIR outage independent of accepted clinical rows, retry and stable resource IDs | Pilot integration with injected failure, followed by real HAPI publication |
| Correct R4 representations | Synthetic `$validate` calls for every mapped resource against the private HAPI R4 server |
| Operational backup/restore, bounded load and security | Existing CI rehearsal/recovery/load and security jobs |

Run the real server acceptance without touching operational clinical records:

```powershell
docker compose --env-file .deployment/deploy.env -f compose.deploy.yaml -f compose.fhir.deploy.yaml --profile tools run --rm --build --no-deps interoperability-check
```

The runner checks R4 metadata, uses only `chs_interoperability_test`, creates random isolated schemas, and cleans its synthetic FHIR resources afterward. It never copies production records into tests. The normal `pnpm db:test` suite runs the same API tests against a configured test-named PostgreSQL database; it uses an in-memory FHIR transport unless `FHIR_TEST_BASE_URL` is explicitly configured.

## Physical Windows acceptance

Use two designated test installations and synthetic patients. Keep existing installed application data; do not uninstall or reset a real installation to test these steps.

1. Build desktop 1.0.2 with the packaged SQLite guard enabled. Install over a test copy of the existing application using **Keep existing data**. Verify installation UUID, local users, prior records, CHS IDs and pending sync state remain unchanged.
2. With networking disabled, create a synthetic patient, screening, vitals, Lifestyle, Food/OTC, referral and follow-up. Close and reopen the app; verify persistence and pending work.
3. Enroll each desktop separately with its own UUID, local location UUID and token. Reconnect, synchronize and confirm acknowledgments/CHS IDs survive another restart. A second sync must not add duplicates.
4. On the second desktop, use the confirmed synthetic identity through the supported reconciliation flow. Check authorship/source labels and central history. Do not manually replace IDs or transplant an acknowledged outbox from another server.
5. Add a late follow-up, addendum and review-status change. Sync and refresh central history; confirm each appears once. Interrupt a paginated download, restart and resume. Disconnect and view the completed saved snapshot.
6. In a synthetic installation, revoke its credential and verify new sync/history requests fail. Rotate/reconfigure as appropriate. Check staff/admin/super admin boundaries and that provider OAuth credentials cannot sync desktop batches.
7. Back up and restore a synthetic desktop database. Check native PDF Save/Print dialogs and representative laptop scaling. Repeat the data-preserving installer upgrade on the second PC.
8. Record tester, installer SHA-256, both software versions, date, outcomes and any defects. Mark a row passed only after it is executed.

## Current installer gate

The 1.0.2 source passes the complete desktop verification suite (2175 tests). Its Windows packaging reached `afterPack`, where Windows Application Control blocked the packaged executable from running. The required in-memory SQLite probe therefore could not finish, and installer creation correctly stopped. This is a build-machine approval dependency, not evidence that a new installer is ready.

The administrator must approve the exact packaged executable under the normal organizational application-control process, or supply an approved signing route. Do not disable application control or bypass the packaged SQLite hook. After approval, rerun the verified Windows build, record its artifact hash and complete the physical acceptance steps. The existing 1.0.1 installer predates merged central-history support and must not be described as the new release.

## Release decision

Source merge, automated tests and a healthy local deployment establish software evidence. They do not assert that manual two-device acceptance, partner-specific FHIR profiles, field training, consent/governance decisions, or OVH production migration have been completed. Keep those outcomes separately recorded. The pilot can expose only approved and explicitly shared data through the provider boundary.
