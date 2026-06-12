import System
import System.Collections.Generic

class NumberEnumerator(Index int32, Current int32) {
    func MoveNext() bool {
        Index = Index + 1
        if Index <= 3 {
            Current = Index * 2
            return true
        }

        return false
    }
}

class Numbers {
    func GetEnumerator() NumberEnumerator {
        return NumberEnumerator(0, 0)
    }
}

var nums = []int32{1, 2, 3}
for v in nums {
    Console.WriteLine(v)
}

var dict = Dictionary[string, int32]()
dict["one"] = 1
dict["two"] = 2
for k, v in dict {
    Console.WriteLine(k)
    Console.WriteLine(v)
}

var list = List[int32]()
list.Add(4)
list.Add(5)
for v in list {
    Console.WriteLine(v)
}

for v in Numbers{} {
    Console.WriteLine(v)
}
