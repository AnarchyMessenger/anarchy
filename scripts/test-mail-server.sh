#!/usr/bin/env bash
# Starts a throwaway Dovecot IMAP server on 127.0.0.1:1143 for the mail tests
# (crates/anarchy-mail/tests). Plain text, localhost only, one user.
#   scripts/test-mail-server.sh && ANARCHY_TEST_IMAP=127.0.0.1:1143 cargo test -p anarchy-mail
set -euo pipefail
dir="${TMPDIR:-/tmp}/anarchy-dovecot"
# Stop the one this script started last time, and wait for its port to free up.
if [ -f "$dir/run/master.pid" ]; then
  doveadm -c "$dir/dovecot.conf" stop 2>/dev/null || kill "$(cat "$dir/run/master.pid")" 2>/dev/null || true
  for _ in $(seq 1 40); do (exec 3<>/dev/tcp/127.0.0.1/1143) 2>/dev/null || break; sleep .25; done
fi
rm -rf "$dir" && mkdir -p "$dir/mail" "$dir/run"
user="$(id -un)"; group="$(id -gn)"; login="$user"; uid="$(id -u)"; gid="$(id -g)"
# Dovecot won't run its login process as root: use its own users then.
if [ "$uid" = 0 ]; then user=dovecot; group=dovecot; login=dovenull; uid="$(id -u dovecot)"; gid="$(id -g dovecot)"; fi
echo "maya:{PLAIN}secret:$uid:$gid::$dir/mail/maya" > "$dir/passwd"
chown -R "$uid:$gid" "$dir/mail"
cat > "$dir/dovecot.conf" <<CONF
protocols = imap
listen = 127.0.0.1
base_dir = $dir/run
state_dir = $dir/run
log_path = $dir/dovecot.log
ssl = no
disable_plaintext_auth = no
auth_mechanisms = plain login
default_internal_user = $user
default_internal_group = $group
default_login_user = $login
mail_location = maildir:~/Maildir
first_valid_uid = 1
service imap-login {
  chroot =
  inet_listener imap {
    address = 127.0.0.1
    port = 1143
  }
}
service anvil {
  chroot =
}
passdb {
  driver = passwd-file
  args = $dir/passwd
}
userdb {
  driver = passwd-file
  args = $dir/passwd
}
CONF
dovecot -c "$dir/dovecot.conf"
for _ in $(seq 1 20); do (exec 3<>/dev/tcp/127.0.0.1/1143) 2>/dev/null && { echo "dovecot on 127.0.0.1:1143 (maya / secret)"; exit 0; }; sleep .25; done
echo "dovecot didn't start; see $dir/dovecot.log" >&2; exit 1
