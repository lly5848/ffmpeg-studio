from PIL import Image, ImageDraw

S = 256
img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


top = (27, 36, 54)    # #1b2436
bot = (79, 140, 255)  # #4f8cff
r = 56
for y in range(S):
    t = y / (S - 1)
    col = lerp(top, bot, t)
    x0, x1 = 0, S
    if y < r:
        inset = int(r - (r * r - (r - y) ** 2) ** 0.5)
        x0, x1 = inset, S - inset
    elif y > S - r:
        inset = int(r - (r * r - (y - (S - r)) ** 2) ** 0.5)
        x0, x1 = inset, S - inset
    d.line([(x0, y), (x1, y)], fill=col + (255,))

cx, cy = S // 2, S // 2
tri = [(cx - 34, cy - 46), (cx - 34, cy + 46), (cx + 56, cy)]
d.polygon(tri, fill=(255, 255, 255, 255))


def bar(x, y, w, h):
    d.rounded_rectangle([x, y, x + w, y + h], radius=6, fill=(255, 255, 255, 60))


bar(S - 70, 30, 40, 8)
bar(S - 70, 46, 40, 8)
bar(30, S - 56, 40, 8)
bar(30, S - 40, 40, 8)

sizes = [16, 24, 32, 48, 64, 128, 256]
out = r"C:\Users\Administrator\WorkBuddy\2026-07-24-20-11-18\ffmpeg-studio\build\icon.ico"
img.save(out, sizes=[(s, s) for s in sizes])
print("saved", out)
