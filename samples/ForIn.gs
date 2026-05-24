import System
import System.Collections.Generic

type NumberEnumerator class(Index int, Current int) {
    func MoveNext() bool {
        Index = Index + 1
        if Index <= 3 {
            Current = Index * 2
            return true
        }

        return false
    }
}

type Numbers class {
    func GetEnumerator() NumberEnumerator {
        return NumberEnumerator(0, 0)
    }
}

var nums = []int{1, 2, 3}
for v in nums {
    Console.WriteLine(v)
}

var dict = Dictionary[string, int]()
dict["one"] = 1
dict["two"] = 2
for k, v in dict {
    Console.WriteLine(k)
    Console.WriteLine(v)
}

var list = List[int]()
list.Add(4)
list.Add(5)
for v in list {
    Console.WriteLine(v)
}

for v in Numbers{} {
    Console.WriteLine(v)
}
