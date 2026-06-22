// file: AddressBook.gs
// Phase 3 exit sample. Combines class declarations with primary constructors
// and instance methods (3.B.3 / ADR-0017), nullable types (3.C.1 / ADR-0020),
// the nil literal (3.C.2), the null-coalescing (??) and null-assertion (!!) operators
// (3.C.3), the null-conditional access operator (3.C.3b), and string
// interpolation (1.1 / ADR-0011). The lookup helper returns a nullable
// `Contact?` so callers can choose between null-coalescing-default and the
// "I-know-this-is-present" assertion. Runs through the conformance harness
// on the emit backend; the interpreter exercises the same constructs in
// Phase 3.C unit tests.

package GSharp.Example.AddressBook

import System

class Contact(Name string, Email string) {
    func Display() string {
        return "$Name <$Email>"
    }
}

class Book(First Contact, Second Contact, Third Contact) {
    func Find(name string) Contact? {
        if First.Name == name {
            return First
        }
        if Second.Name == name {
            return Second
        }
        if Third.Name == name {
            return Third
        }
        return nil
    }
}

var book = Book(
    Contact("Alice", "alice@example.com"),
    Contact("Bob", "bob@example.com"),
    Contact("Carol", "carol@example.com"))

var hit = book.Find("Bob")
Console.WriteLine(hit?.Display() ?? "no match")

var miss = book.Find("Zoe")
Console.WriteLine(miss?.Display() ?? "no match")

// `!!` asserts non-null and lets us reach members on the result directly.
var forced = book.Find("Alice")!!
Console.WriteLine(forced.Display())
