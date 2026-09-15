package GenericLocalRecursion

import System

class Example {
    shared {
        private func Value() int32 {
            return 17
        }

        func Run() int32 {
            let left[T] = func (x T, depth int32) int32 {
                if depth == 0 {
                    return Value()
                }
                return right(x, depth - 1)
            }
            let right[U] = func (x U, depth int32) int32 {
                return left(x, depth)
            }
            return left("private", 2)
        }
    }
}

let first[T, U] = func (a T, b U, n int32) string {
    if n == 0 {
        return "${a}:${b}"
    }
    return second[U, T](b, a, n - 1)
}
let second[X, Y] = func (a X, b Y, n int32) string {
    return third(a, b, n)
}
let third[A, B] = func (a A, b B, n int32) string {
    return first[A, B](a, b, n)
}

Console.WriteLine(first(42, "x", 3))
Console.WriteLine(first("y", 7, 2))
Console.WriteLine(Example.Run())
