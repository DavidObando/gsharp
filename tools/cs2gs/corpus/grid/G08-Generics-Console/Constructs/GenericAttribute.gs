// inventory: Attribute — generic attribute class applied with a type argument
// (C#11 probe, issue #1913 fixed). The applied instance is read back via
// reflection (as `TagAttribute<int>`) and its `KindName()` (`typeof(T).Name`)
// exercised, so the emitted G# generic attribute really closed the type
// argument rather than silently keeping the open generic definition.

package Corpus.Grid08

import System
import System.Linq

@AttributeUsage(AttributeTargets.All)
class TagAttribute[T] : Attribute {
    func KindName() string {
        return typeof(T).Name
    }
}

@Tag[int32]
open class TaggedCrate {
    func Weight() int32 {
        return 30
    }
}

shared class GenericAttributeFixture {
    func Run() {
        let crate = TaggedCrate()
        Console.WriteLine("GenericAttribute: weight=" + crate.Weight().ToString())
        let tag = typeof(TaggedCrate).GetCustomAttributes(true).OfType[TagAttribute[int32]]().First()
        Console.WriteLine("GenericAttribute: kind=" + tag.KindName())
    }
}
