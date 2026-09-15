package Examples.Kotlin

import System

data class Developer(Name string, Years int32)

func label(person Developer?) string ->
if let known = person {
    "${known.Name}: ${known.Years}"
} else {
    "unassigned"
}

let ada = Developer("Ada", 2)
let next = ada with{Years = 3}
Console.WriteLine(label(next))
Console.WriteLine(label(nil))
Console.WriteLine(ada == Developer("Ada", 2))
