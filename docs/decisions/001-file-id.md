## Why the fileId

The fileId is derived from the chunk hashes rather than streaming the whole file at once to get a hash of the entire file at once because crypto.subtle.digest cannot hash data piece by piece, chunks hashes are already computed, so hashin those is essentially free, and it is a step towards Merkle root, which later let't the receiver verify any single chunk on it own. However, the cost of this is that the hash we generate is dependent on the chunk size so the same file with different chunk size will not produce the same hash and there not be considered as one.
