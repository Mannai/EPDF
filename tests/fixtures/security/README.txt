Fixtures in this folder are produced by qpdf (an independent implementation) from one plaintext source
(3 pages: "Secret page N", "The quick brown fox jumps over the lazy dog 12345.", Title "Security Fixture Title").
Regenerate with: node tests/fixtures/security.mjs

file                          user password     owner password    notes
rc4-40                        "user40"          "owner40"         40
rc4-128                       "user128"         "owner128"        128 --use-aes=n
aes-128                       "userAes"         "ownerAes"        128 --use-aes=y
aes-256-r6                    "user256"         "owner256"        256
aes-256-r5                    "user5"           "owner5"          256 --force-R5
user-only                     "onlyuser"        "ownerZZZ"        256
owner-only                    ""                "onlyowner"       256
no-permissions-aes128         "u128"            "o128"            128 --use-aes=y --print=none --modify=none --extract=n --annotate=n --assemble=n --form=n --modify-other=n --accessibility=n
no-permissions-aes256         "u256p"           "o256p"           256 --print=none --modify=none --extract=n --annotate=n --assemble=n --form=n --modify-other=n --accessibility=n
lowres-print-rc4-128          "ulow"            "olow"            128 --use-aes=n --print=low
cleartext-metadata-aes128     "umeta"           "ometa"           128 --use-aes=y --cleartext-metadata
cleartext-metadata-aes256     "umeta6"          "ometa6"          256 --cleartext-metadata
objstm-aes256                 "userObj"         "ownerObj"        256
objstm-aes128                 "userObj"         "ownerObj"        128 --use-aes=y
objstm-rc4-128                "userObj"         "ownerObj"        128 --use-aes=n --force-V4
unicode-password-aes256       "pässö€"          "oüw"             256
latin1-password-rc4-128       "pässö"           "oüw"             128 --use-aes=n
