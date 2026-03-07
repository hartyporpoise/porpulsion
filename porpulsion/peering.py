"""
peering.py — legacy module, no longer used.

The old two-step HTTP handshake (/peer POST + accept_inbound callback) and
mTLS verify_peer / identify_peer helpers have been replaced by the signed
invite bundle + peer/hello challenge/response protocol over the WS channel.

See: tls.sign_bundle / tls.verify_bundle / tls.sign_challenge / tls.verify_challenge
     channel.py: _connect() and attach_inbound()
     routes/peers.py: get_invite() and connect_peer()
"""
