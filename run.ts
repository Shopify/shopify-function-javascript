export type UserFunction<Input extends {}, Output extends {}> = (
  input: Input
) => Output;

interface ShopifyFunction {
  readInput(): any;
  writeOutput(val: any);
}

declare global {
  const ShopifyFunction: ShopifyFunction;
}

export default function <I extends {}, O extends {}>(
  userfunction: UserFunction<I, O>
) {
  try {
    ShopifyFunction;
  } catch (e) {
    throw new Error(
      "ShopifyFunction is not defined. Please rebuild your function using the latest version of Shopify CLI."
    );
  }

  const input_obj = ShopifyFunction.readInput();
  const output_obj = userfunction(input_obj);
  ShopifyFunction.writeOutput(output_obj);
}
