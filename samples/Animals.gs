// file: Animals.gs
// ADR-0147: structural literal-to-type assignability (width subtyping).
// An object literal satisfies a concrete target when all required members
// are present with compatible types.  Extra literal members are allowed.

package GSharp.Example.Animals

import System

data struct Pet {
    var Name string
    var Age int32
}

class Robot {
    var Model string
    var Active bool
}

data struct BigAge {
    var Name string
    var Age int64
}

struct Empty { }

func describe(p Pet) {
    Console.WriteLine("${p.Name} is ${p.Age}")
}

func tag(p Pet) {
    Console.WriteLine("tagged: ${p.Name}")
}

func identify(r Robot) {
    Console.WriteLine("${r.Model}: ${r.Active}")
}

func showBigAge(b BigAge) {
    Console.WriteLine("${b.Name}: ${b.Age}")
}

func showEmpty(e Empty) {
    Console.WriteLine("empty ok")
}

describe(object { let Name = "Fido"; let Age = 4 })
tag(object { let Name = "Rex"; let Age = 2; let Extra = "ignored" })
identify(object { let Model = "C-3PO"; let Active = true })
showBigAge(object { let Name = "Methuselah"; let Age = 969 })
showEmpty(object {})
