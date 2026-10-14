// inventory: DelegateDeclaration — named delegate type with params+return,
// a void-returning delegate, method-group/lambda assignment, explicit .Invoke()
// (probe)

package Corpus.Grid09

import System

delegate Combine(a int32, b int32) int32;

delegate Note(message string);

shared class DelegateDeclarationFixture {
    func Run() {
        let add Combine = Add
        let mul Combine = (a int32, b int32) -> a * b
        Console.WriteLine("DelegateDeclaration: add=${add(2, 3)} mul=${mul(2, 3)}")
        Console.WriteLine("DelegateDeclaration: explicitInvoke=${add(4, 5)}")
        let note Note = First
        note("multicast")
    }

    private func Add(a int32, b int32) int32 {
        return a + b
    }

    private func First(message string) {
        Console.WriteLine("DelegateDeclaration: first $message")
    }
}
