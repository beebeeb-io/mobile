# Beebeeb preview-matrix fixture — Ruby (task 1565).

GREETING = "café naïve 日本語 Ελληνικά Москва €19.99"

def long_line
  (["0123456789"] * 20).join(" ") + " end-of-long-line"
end

puts GREETING
puts long_line
