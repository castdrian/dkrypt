# dkrypt Helm chart

The chart runs dkrypt as a single replica with persistent SQLite state, artifact storage, and device SSH material. SQLite and the job worker are single-instance; the chart rejects replica counts other than one.

Create a Kubernetes Secret from the environment file used by your self-hosted deployment. Keep it in your cluster's secret manager and include the required runtime settings such as `API_KEY`, `SESSION_SIGNING_SECRET`, `ADMIN_PASSWORD`, and `BACKUP_MANIFEST_SECRET`. Then install the chart:

```sh
kubectl create secret generic dkrypt-runtime --from-env-file=.env
helm upgrade --install dkrypt ./deploy/helm/dkrypt --namespace dkrypt --create-namespace --set secrets.existingSecret=dkrypt-runtime --set image.tag=YOUR_RELEASE
```

The service uses PVCs for state, artifacts, and the generated device SSH key. Set `persistence.*.storageClass` or `persistence.*.existingClaim` to match the cluster. For a USB device attached to the Kubernetes node, set `usbAccess.enabled=true`, schedule dkrypt onto that node with `nodeSelector` or affinity, and confirm the cluster permits the host `/dev/bus/usb` mount and privileged device access. USB access is disabled by default; Wi-Fi discovery depends on network multicast support.

Set `ingress.enabled=true`, configure a TLS-enabled ingress, and set `PUBLIC_BASE_URL` in the runtime Secret to the resulting public origin before enabling OAuth or payment webhooks. The default probes check that the public API reference endpoint is responding; they do not mark the device unavailable as a failed pod.
