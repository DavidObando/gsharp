// inventory: TypeParameter — declaration-site variance: covariant (out) and contravariant (in) interfaces (probe)
// Note: in/out variance on DELEGATES is not exercised here because DelegateDeclaration
// itself is CS2GS-GAP (see G07 Quarantined/EventDeclaration.cs.txt).

package Corpus.Grid08

import System

interface ISource[out T] {
    func Get() T;
}

interface ISink[in T] {
    func Accept(value T) string;
}

open class StringSource : ISource[string] {
    func Get() string {
        return "made"
    }
}

open class ObjectSink : ISink[object] {
    func Accept(value object) string {
        return "took:" + value.ToString()
    }
}

shared class TypeParameterFixture {
    func Run() {
        let source ISource[string] = StringSource()
        let widened ISource[object] = source
        Console.WriteLine("TypeParameter: covariant=" + widened.Get().ToString())
        let sink ISink[object] = ObjectSink()
        let narrowed ISink[string] = sink
        Console.WriteLine("TypeParameter: contravariant=" + narrowed.Accept("note"))
    }
}
