// L1-Console: the simplest corpus level. A deterministic console program whose
// stdout is the parity oracle (no timestamps / random / GUIDs).
//
// Exercises (ADR-0115 section B):
//   B.1  namespace + System usage
//   B.2  brace/indent style
//   B.3  local var / const, never-reassigned vs reassigned locals
//   B.4  a plain reference class
//   B.5  in-body instance methods on an owned type
//   B.6  field declarations with a constructor
//   B.9  string interpolation, including a format specifier and a literal '$'
//
// Note: this file intentionally uses ordinary C# style (underscore-prefixed
// private fields, no StyleCop file header, implicit `this`). If the repo-shared
// StyleCop + TreatWarningsAsErrors leaked in, this would fail to build - so a
// clean build proves the corpus isolation works.
using System;
using System.Collections.Generic;

namespace Corpus.L1
{
    internal sealed class Cart
    {
        private readonly string _customer;
        private readonly List<(string Name, int Price, int Quantity)> _items;

        public Cart(string customer)
        {
            _customer = customer;
            _items = new List<(string, int, int)>();
        }

        public void Add(string name, int price, int quantity)
        {
            _items.Add((name, price, quantity));
        }

        public int Subtotal()
        {
            var total = 0;
            foreach (var item in _items)
            {
                total += item.Price * item.Quantity;
            }

            return total;
        }

        public int LineCount => _items.Count;

        public void PrintReceipt()
        {
            const int taxPercent = 8;
            Console.WriteLine($"Receipt for {_customer}");
            Console.WriteLine("----------------------");

            var index = 1;
            foreach (var item in _items)
            {
                int lineTotal = item.Price * item.Quantity;
                Console.WriteLine($"{index}. {item.Name} x{item.Quantity} @ {item.Price} = {lineTotal}");
                index++;
            }

            int subtotal = Subtotal();
            int tax = (subtotal * taxPercent) / 100;
            int grandTotal = subtotal + tax;

            Console.WriteLine("----------------------");
            Console.WriteLine($"Subtotal: {subtotal}");
            Console.WriteLine($"Tax ({taxPercent}%): {tax}");
            Console.WriteLine($"Total: {grandTotal}");
        }
    }

    internal static class Program
    {
        private static void Main()
        {
            var cart = new Cart("Ada");
            cart.Add("Notebook", 5, 3);
            cart.Add("Pen", 2, 4);
            cart.Add("Marker", 3, 2);
            cart.PrintReceipt();

            Console.WriteLine();
            PrintFizzBuzz(15);

            Console.WriteLine();
            Console.WriteLine($"Items in cart: {cart.LineCount}");
            Console.WriteLine($"Greeting uses a literal dollar sign: $5 each");
        }

        private static void PrintFizzBuzz(int upTo)
        {
            int n = 1;
            while (n <= upTo)
            {
                string label;
                if (n % 15 == 0)
                {
                    label = "FizzBuzz";
                }
                else if (n % 3 == 0)
                {
                    label = "Fizz";
                }
                else if (n % 5 == 0)
                {
                    label = "Buzz";
                }
                else
                {
                    label = n.ToString();
                }

                Console.WriteLine($"{n} -> {label}");
                n++;
            }

            int evens = 0;
            for (int i = 1; i <= upTo; i++)
            {
                if (i % 2 == 0)
                {
                    evens++;
                }
            }

            Console.WriteLine($"Evens from 1..{upTo}: {evens}");
        }
    }
}
