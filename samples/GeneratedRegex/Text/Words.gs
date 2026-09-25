package GeneratedRegex.Text

import System.Text.RegularExpressions

// A second package using the generator: the generator's helper types are
// emitted once and shared by every package.
partial class Words {
    shared {
        @GeneratedRegex("\\b\\w+\\b")
        internal partial func Word() Regex;

        public func Count(s string) int32 {
            return Word().Count(s)
        }
    }
}
