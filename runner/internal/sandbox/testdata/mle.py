blocks = []
while True:
    blocks.append(b"x" * (1 << 20))  # 1 MiB, filled (resident), not constant-folded
