# Sentaurus VM Worker

This directory is the independently deployable CentOS-side worker for Sentaurus Web Agent.
It supports Python 2.7 and Python 3 and keeps model credentials and runtime state inside the VM.

## Install or upgrade

```bash
cd vm-worker
./install.sh
~/.sentaurus-web-agent/vm-agent/vm-agent-autostart.sh restart
```

The installer updates program files while preserving `.env`, `config.json`, `AGENTS.md`,
manuals, queues, messages, goals, logs, and simulation outputs.

For a first installation, create the private configuration from one of the examples:

```bash
cp ~/.sentaurus-web-agent/vm-agent/.env.example ~/.sentaurus-web-agent/vm-agent/.env
chmod 600 ~/.sentaurus-web-agent/vm-agent/.env
```

Never commit or publish the resulting `.env` or `config.json`.

## Autostart

The launcher supports `start`, `status`, `stop`, and `restart`. To run it after reboot:

```cron
@reboot BOOT_DELAY_SECONDS=20 /home/TCAD2022/.sentaurus-web-agent/vm-agent/vm-agent-autostart.sh start >> /home/TCAD2022/.sentaurus-web-agent/vm-agent/autostart.log 2>&1
```

Set `WORKER_COUNT` to control concurrency; the current deployment uses two workers.

## Repository boundary

Included: worker source, DF-ISE extractor, launcher, configuration examples, AGENTS template,
and capability metadata.

Excluded: credentials, message/audit history, goals, queues, logs, PID/heartbeat files,
manual text, simulation decks/results, and backup copies.
