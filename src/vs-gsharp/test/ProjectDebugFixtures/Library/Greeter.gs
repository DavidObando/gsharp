package VsAcceptance.Library

class Greeter(Name string) {
    func Greet() string {
        var punctuation = "!" // BREAKPOINT:library-step
        return "Hello, " + Name + punctuation
    }
}
