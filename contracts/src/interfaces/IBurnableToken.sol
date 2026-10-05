// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IBurnableToken is IERC20 {
    function burn(uint256 value) external;
    function burnFrom(address account, uint256 value) external;
}
