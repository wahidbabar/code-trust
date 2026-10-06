#!/bin/sh
# Installed as /opt/bin/git. The analyzer runs git with only PATH and HOME, so Lambda's
# LD_LIBRARY_PATH never reaches it, and Amazon Linux's git looks for its helpers
# (git-remote-https) and templates under /usr. This puts both back on the layer's copies.
# LD_LIBRARY_PATH is set, not appended to, so git finds the same libraries whoever calls it.
export LD_LIBRARY_PATH=/opt/lib
export GIT_EXEC_PATH=/opt/libexec/git-core
export GIT_TEMPLATE_DIR=/opt/share/git-core/templates
exec /opt/libexec/git-core/git "$@"
