package GeneratedRegex

import System.Text.RegularExpressions

// ADR-0192 follow-on 2: each `@GeneratedRegex` method is a body-less
// declaring part. The Regex source generator supplies the implementing part
// at build time (through gsgen), and gsc pairs the two. A partial method of
// a static helper lives in a `shared { }` block: `private shared partial func`
// is not G# syntax.
partial class Patterns {
    shared {
        // A pattern with options and named captures.
        @GeneratedRegex("^(?<y>\\d{4})-(?<m>\\d{2})$", RegexOptions.IgnoreCase)
        private partial func IsoMonth() Regex;

        // A backtracking pattern: the greedy `.*` gives characters back until
        // three digits can end the match.
        @GeneratedRegex("^(.*)(\\d{3})$")
        private partial func LastThree() Regex;

        // The header may be spelled however the user likes: gsgen spells the
        // generated implementing part with this declaring part's own header.
        @GeneratedRegex("\\d+")
        private partial func Digits() System.Text.RegularExpressions.Regex;

        public func Month(s string) string {
            let m = IsoMonth().Match(s)
            if m.Success {
                return m.Groups["m"].Value
            }

            return "none"
        }

        public func Tail(s string) string {
            let m = LastThree().Match(s)
            if m.Success {
                return m.Groups[1].Value + "|" + m.Groups[2].Value
            }

            return "none"
        }

        public func FirstNumber(s string) string {
            return Digits().Match(s).Value
        }

        // The generated `Regex` subclass lives in the generator's own package.
        public func Implementation() string {
            return Digits().GetType().Namespace!!
        }
    }
}

// A user type with the same name as one of the generator's helper types:
// they live in different packages, so they do not collide.
class Utilities {
    shared {
        public func Describe() string {
            return "user Utilities"
        }
    }
}
