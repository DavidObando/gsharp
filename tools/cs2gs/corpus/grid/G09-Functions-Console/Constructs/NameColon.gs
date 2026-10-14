// inventory: NameColon

package Corpus.Grid09

import System

shared class NameColonFixture {
    func Run() {
        Console.WriteLine("NameColon: inOrder=${Describe(name: "cat", count: 2, loud: false)}")
        Console.WriteLine("NameColon: outOfOrder=${Describe(count: 1, loud: true, name: "dog")}")
        Console.WriteLine("NameColon: mixed=${Describe("fox", loud: false, count: 3)}")
    }

    private func Describe(name string, count int32, loud bool) string {
        let text = "${count}x$name"
        return if loud {
            text.ToUpperInvariant()
        } else {
            text
        }
    }
}
