# Move dkrypt to another host

The migration helper creates an encrypted snapshot of the source checkout, `.env`, SQLite state, IPA artifacts, and generated device SSH key. It stops dkrypt while copying persistent volumes so SQLite and files stay consistent, then restarts the source. Use an `age` recipient whose identity is available on the destination; the archive and `.env` are encrypted together.

Install Docker Compose and `age` on both hosts. From the source checkout, provide the destination's age public recipient and an output path for the bundle:

```sh
scripts/host-migration.sh export age1... /secure/path/dkrypt-migration.age
```

Transfer the bundle and the matching private age identity through your normal secure process. Stop dkrypt on the old host before restoring, so both copies do not process jobs or webhooks at once. On the new host, choose an empty destination directory:

```sh
scripts/host-migration.sh restore /secure/path/identity.txt /secure/path/dkrypt-migration.age /srv/dkrypt
```

The restore extracts the committed source revision, restores the three Docker volumes, starts the service, and checks the authenticated health endpoint. If that check fails, the new service is stopped and the source data remains untouched. Keep the old host and encrypted bundle until the new host's device, dashboard, artifacts, and backups have been checked. The generated device SSH key is migrated with its volume; USB hardware must be attached to the new host and device setup may need to be rechecked.
